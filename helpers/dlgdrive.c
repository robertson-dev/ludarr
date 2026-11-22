/*
 * dlgdrive — drives a Windows installer that has no silent mode, under wine on a virtual display.
 *
 * Two kinds of window are known (both TENOKE's; the agent worked them out by hand before this existed):
 *   dialog  — a real dialog (#32770) with Edit / checkbox / Button controls: the directory box gets the target,
 *             every checkbox is cleared (desktop shortcut, uninstaller), the INSTALL button gets BM_CLICK.
 *   custom  — an owner-drawn window ("TenokeSetupWindow") whose only real control is the directory Edit: the Edit
 *             gets the target, then Return is pressed in it (TENOKE 2.x draws its buttons with Direct2D, which
 *             does not even render under Xvfb, but Return in the box starts the install); if nothing happens the
 *             painted INSTALL button of the older build is clicked by position, left of centre on the bottom row.
 *             A trigger counts when the target folder starts filling or the window changes.
 * Then it waits for completion: a 100% text, a "complete" message, a second window popping up over a custom
 * installer, or the installer closing. Progress (percent text, bytes written) is printed as it goes.
 *
 *   wine dlgdrive.exe --dir "Z:\path\to\staging" [--button INSTALL] [--click 0.45,0.88] [--wait-sec 180]
 *                     [--timeout-sec 5400] [--keep-checks] [--dump]
 *
 * Exit codes: 0 done · 2 no usable window appeared / nothing reacted to the clicks · 3 timed out · 1 bad arguments.
 * Built with mingw-w64 in the Docker image (helpers/dlgdrive.c → /usr/local/bin/dlgdrive.exe); no binary is checked in.
 */
#ifndef UNICODE
#define UNICODE
#define _UNICODE
#endif
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>
#include <wctype.h>

static const wchar_t *g_dir = NULL;
static wchar_t g_button[64] = L"INSTALL";
static int g_wait = 180, g_timeout = 5400, g_keep = 0, g_dump = 0;
static double g_cx = -1, g_cy = -1;              /* --click: one fixed spot instead of the candidates */
static const wchar_t *g_shot = NULL;             /* --shot file.bmp: a picture of the installer window, for whoever debugs a new layout */
static int g_probe = 0;                           /* --probe: list where the cursor turns into a hand (the painted buttons), then stop */

/* ── small helpers ── */
static void textOf(HWND h, wchar_t *out, int n) {
  wchar_t raw[512];
  int len = GetWindowTextW(h, raw, 512), j = 0;
  for (int i = 0; i < len && j < n - 1; i++) if (raw[i] != L'&') out[j++] = (wchar_t)towupper(raw[i]);
  out[j] = 0;
}
static int isClass(HWND h, const wchar_t *name) { wchar_t cls[64]; GetClassNameW(h, cls, 64); return _wcsicmp(cls, name) == 0; }
static int isCheckbox(HWND h) {
  LONG_PTR st = GetWindowLongPtrW(h, GWL_STYLE) & 0xF;
  return st == BS_CHECKBOX || st == BS_AUTOCHECKBOX || st == BS_3STATE || st == BS_AUTO3STATE;
}
static const wchar_t *gb(unsigned long long b, wchar_t *buf) { swprintf(buf, 32, L"%.2f GB", b / 1e9); return buf; }

/* the target folder: files and bytes — a custom window says nothing, the folder does */
typedef struct { unsigned long long bytes; int files; } DirStat;
static void statDir(const wchar_t *dir, DirStat *d, int depth) {
  if (depth > 8) return;
  wchar_t pat[2048]; swprintf(pat, 2048, L"%ls\\*", dir);
  WIN32_FIND_DATAW fd; HANDLE h = FindFirstFileW(pat, &fd);
  if (h == INVALID_HANDLE_VALUE) return;
  do {
    if (!wcscmp(fd.cFileName, L".") || !wcscmp(fd.cFileName, L"..")) continue;
    if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) { wchar_t sub[2048]; swprintf(sub, 2048, L"%ls\\%ls", dir, fd.cFileName); statDir(sub, d, depth + 1); }
    else { d->files++; d->bytes += ((unsigned long long)fd.nFileSizeHigh << 32) | fd.nFileSizeLow; }
  } while (FindNextFileW(h, &fd));
  FindClose(h);
}

/* ── what is on screen ── */
typedef struct { HWND wnd; HWND button; HWND edit; int buttons; int edits; } Pick;
typedef struct { Pick dialog; Pick custom; int visible; } Scene;
static BOOL CALLBACK pickChild(HWND h, LPARAM lp) {
  Pick *p = (Pick *)lp; wchar_t txt[512];
  if (isClass(h, L"Edit")) { p->edits++; if (!p->edit) p->edit = h; return TRUE; }
  if (!isClass(h, L"Button")) return TRUE;
  p->buttons++;
  textOf(h, txt, 512);
  if (wcsstr(txt, g_button) && wcsncmp(txt, L"UN", 2) != 0 && !isCheckbox(h) && IsWindowEnabled(h)) p->button = h;
  return TRUE;
}
static BOOL CALLBACK pickTop(HWND h, LPARAM lp) {
  Scene *s = (Scene *)lp;
  if (!IsWindowVisible(h)) return TRUE;
  RECT rc; GetWindowRect(h, &rc);
  if (rc.right - rc.left < 200 || rc.bottom - rc.top < 120) return TRUE;      /* IME / tray helpers */
  s->visible++;
  Pick c = { h, NULL, NULL, 0, 0 };
  EnumChildWindows(h, pickChild, (LPARAM)&c);
  if (c.button && !s->dialog.wnd) s->dialog = c;
  else if (c.edit && c.buttons == 0 && !s->custom.wnd) s->custom = c;
  return TRUE;
}

typedef struct { int visible; int done; int finished; HWND okBtn; HWND yesBtn; wchar_t pct[64]; } Watch;
static int saysDone(const wchar_t *t) { return wcsstr(t, L"100%") || wcsstr(t, L"100.0%") || wcsstr(t, L"100,0%"); }
static BOOL CALLBACK watchChild(HWND h, LPARAM lp) {
  Watch *w = (Watch *)lp; wchar_t txt[512];
  textOf(h, txt, 512);
  if (!txt[0]) return TRUE;
  if (saysDone(txt)) w->done = 1;
  if (wcschr(txt, L'%') && wcslen(txt) < 40) { wcsncpy(w->pct, txt, 63); w->pct[63] = 0; }
  if (isClass(h, L"Button") && !isCheckbox(h)) {
    if (!wcscmp(txt, L"OK") || !wcscmp(txt, L"CLOSE") || !wcscmp(txt, L"FINISH") || !wcscmp(txt, L"EXIT") || !wcscmp(txt, L"DONE")) w->okBtn = h;
    if (!wcscmp(txt, L"YES")) w->yesBtn = h;
  } else if (isClass(h, L"Static") && (wcsstr(txt, L"COMPLETE") || wcsstr(txt, L"FINISHED") || wcsstr(txt, L"SUCCESS") || wcsstr(txt, L"HAS BEEN INSTALLED"))) w->finished = 1;
  return TRUE;
}
static BOOL CALLBACK watchTop(HWND h, LPARAM lp) {
  Watch *w = (Watch *)lp; wchar_t txt[512];
  if (!IsWindowVisible(h)) return TRUE;
  RECT rc; GetWindowRect(h, &rc);
  if (rc.right - rc.left < 40 || rc.bottom - rc.top < 20) return TRUE;
  w->visible++;
  textOf(h, txt, 512);
  if (saysDone(txt)) w->done = 1;
  EnumChildWindows(h, watchChild, lp);
  return TRUE;
}

/* a dump of what is on screen, for the log when nothing fits */
static BOOL CALLBACK dumpChild(HWND h, LPARAM lp) {
  wchar_t cls[64], txt[200]; GetClassNameW(h, cls, 64); textOf(h, txt, 200); RECT rc; GetWindowRect(h, &rc);
  wprintf(L"      %ls %ldx%ld '%ls'%ls\n", cls, rc.right - rc.left, rc.bottom - rc.top, txt, IsWindowVisible(h) ? L"" : L" (hidden)");
  (void)lp; return TRUE;
}
static BOOL CALLBACK dumpTop(HWND h, LPARAM lp) {
  if (!IsWindowVisible(h)) return TRUE;
  wchar_t cls[64], txt[200]; GetClassNameW(h, cls, 64); textOf(h, txt, 200); RECT rc; GetWindowRect(h, &rc);
  wprintf(L"   window %ls %ldx%ld at %ld,%ld '%ls'\n", cls, rc.right - rc.left, rc.bottom - rc.top, rc.left, rc.top, txt);
  EnumChildWindows(h, dumpChild, lp); return TRUE;
}
static void dump(void) { wprintf(L"on screen:\n"); EnumWindows(dumpTop, 0); }

/* ── a picture of the window (24-bit BMP) and a hand-cursor probe, for new layouts ── */
static void shot(HWND wnd, const wchar_t *path) {
  RECT rc; GetWindowRect(wnd, &rc); int w = rc.right - rc.left, h = rc.bottom - rc.top;
  HDC sdc = GetDC(NULL); HDC mdc = CreateCompatibleDC(sdc);
  BITMAPINFO bi; memset(&bi, 0, sizeof bi);
  bi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER); bi.bmiHeader.biWidth = w; bi.bmiHeader.biHeight = -h; bi.bmiHeader.biPlanes = 1; bi.bmiHeader.biBitCount = 24; bi.bmiHeader.biCompression = BI_RGB;
  void *bits = NULL; HBITMAP bmp = CreateDIBSection(sdc, &bi, DIB_RGB_COLORS, &bits, NULL, 0);
  if (!bmp) { wprintf(L"no bitmap for the screenshot\n"); return; }
  HGDIOBJ old = SelectObject(mdc, bmp);
  BitBlt(mdc, 0, 0, w, h, sdc, rc.left, rc.top, SRCCOPY | CAPTUREBLT);
  GdiFlush();
  DWORD stride = ((w * 3 + 3) & ~3), size = stride * h;
  BITMAPFILEHEADER fh; fh.bfType = 0x4D42; fh.bfReserved1 = fh.bfReserved2 = 0; fh.bfOffBits = sizeof(BITMAPFILEHEADER) + sizeof(BITMAPINFOHEADER); fh.bfSize = fh.bfOffBits + size;
  bi.bmiHeader.biSizeImage = size;
  FILE *f = _wfopen(path, L"wb");
  if (f) { fwrite(&fh, sizeof fh, 1, f); fwrite(&bi.bmiHeader, sizeof(BITMAPINFOHEADER), 1, f); fwrite(bits, 1, size, f); fclose(f); wprintf(L"screenshot %dx%d written to %ls\n", w, h, path); }
  SelectObject(mdc, old); DeleteObject(bmp); DeleteDC(mdc); ReleaseDC(NULL, sdc);
}
static void moveTo(int x, int y) {
  int sw = GetSystemMetrics(SM_CXSCREEN), sh = GetSystemMetrics(SM_CYSCREEN);
  INPUT in; memset(&in, 0, sizeof in); in.type = INPUT_MOUSE;
  in.mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE; in.mi.dx = (LONG)(x * 65535.0 / sw); in.mi.dy = (LONG)(y * 65535.0 / sh);
  SendInput(1, &in, sizeof in);
}
/* the cursor over a point: 0 arrow/none, 1 hand, 2 I-beam, 3 other */
static int cursorKind(void) {
  CURSORINFO ci; ci.cbSize = sizeof ci;
  if (!GetCursorInfo(&ci) || !ci.hCursor) return 0;
  if (ci.hCursor == LoadCursorW(NULL, IDC_HAND)) return 1;
  if (ci.hCursor == LoadCursorW(NULL, IDC_IBEAM)) return 2;
  if (ci.hCursor == LoadCursorW(NULL, IDC_ARROW)) return 0;
  return 3;
}
/* sweep the window on a grid and print the spots where the cursor changes, as rectangles relative to the window */
static void probe(HWND wnd) {
  RECT rc; GetWindowRect(wnd, &rc); int w = rc.right - rc.left, h = rc.bottom - rc.top, step = 12;
  SetForegroundWindow(wnd);
  wprintf(L"probing %dx%d every %d px (. arrow  H hand  I text  ? other)\n", w, h, step);
  for (int y = step / 2; y < h; y += step) {
    wchar_t line[400]; int n = 0;
    for (int x = step / 2; x < w && n < 398; x += step) { moveTo(rc.left + x, rc.top + y); Sleep(25); int k = cursorKind(); line[n++] = k == 1 ? L'H' : k == 2 ? L'I' : k == 3 ? L'?' : L'.'; }
    line[n] = 0; wprintf(L"%4d %ls\n", y, line);
  }
}

/* ── acting ── */
static BOOL CALLBACK fillChild(HWND h, LPARAM lp) {
  wchar_t txt[512];
  (void)lp;
  if (isClass(h, L"Edit") && g_dir) {
    SendMessageW(h, WM_SETTEXT, 0, (LPARAM)g_dir);
    wprintf(L"directory box set to %ls\n", g_dir);
  } else if (isClass(h, L"Button") && !g_keep && isCheckbox(h)) {
    textOf(h, txt, 512);
    if (SendMessageW(h, BM_GETCHECK, 0, 0) != BST_UNCHECKED) { SendMessageW(h, BM_SETCHECK, BST_UNCHECKED, 0); wprintf(L"unchecked '%ls'\n", txt); }
  }
  return TRUE;
}
static void clickAt(HWND wnd, double fx, double fy, int viaInput) {
  RECT rc; GetWindowRect(wnd, &rc);
  POINT pt = { rc.left + (LONG)((rc.right - rc.left) * fx), rc.top + (LONG)((rc.bottom - rc.top) * fy) };
  POINT cl = pt; ScreenToClient(wnd, &cl);
  if (!viaInput) {
    LPARAM lp = MAKELPARAM(cl.x, cl.y);
    PostMessageW(wnd, WM_MOUSEMOVE, 0, lp); Sleep(120);
    PostMessageW(wnd, WM_LBUTTONDOWN, MK_LBUTTON, lp); Sleep(120);
    PostMessageW(wnd, WM_LBUTTONUP, 0, lp);
  } else {
    SetForegroundWindow(wnd);
    int sw = GetSystemMetrics(SM_CXSCREEN), sh = GetSystemMetrics(SM_CYSCREEN);
    INPUT in; memset(&in, 0, sizeof in); in.type = INPUT_MOUSE;
    in.mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE; in.mi.dx = (LONG)(pt.x * 65535.0 / sw); in.mi.dy = (LONG)(pt.y * 65535.0 / sh);
    SendInput(1, &in, sizeof in); Sleep(150);
    in.mi.dwFlags = MOUSEEVENTF_LEFTDOWN; in.mi.dx = in.mi.dy = 0; SendInput(1, &in, sizeof in); Sleep(120);
    in.mi.dwFlags = MOUSEEVENTF_LEFTUP; SendInput(1, &in, sizeof in);
  }
  wprintf(L"clicked at %ld,%ld (%.0f%%, %.0f%% of the window) via %ls\n", pt.x, pt.y, fx * 100, fy * 100, viaInput ? L"input" : L"messages");
}
static void pressReturnIn(HWND edit, HWND wnd, int viaInput) {
  RECT er; GetWindowRect(edit, &er);
  POINT c = { (er.left + er.right) / 2, (er.top + er.bottom) / 2 }, cl = c; ScreenToClient(edit, &cl);
  if (!viaInput) {
    LPARAM lp = MAKELPARAM(cl.x, cl.y);
    PostMessageW(edit, WM_LBUTTONDOWN, MK_LBUTTON, lp); Sleep(80); PostMessageW(edit, WM_LBUTTONUP, 0, lp); Sleep(300);
    PostMessageW(edit, WM_KEYDOWN, VK_RETURN, 0x001C0001); Sleep(40); PostMessageW(edit, WM_CHAR, VK_RETURN, 0x001C0001); Sleep(40); PostMessageW(edit, WM_KEYUP, VK_RETURN, 0xC01C0001);
  } else {
    SetForegroundWindow(wnd); moveTo(c.x, c.y); Sleep(120);
    INPUT in[2]; memset(in, 0, sizeof in);
    in[0].type = INPUT_MOUSE; in[0].mi.dwFlags = MOUSEEVENTF_LEFTDOWN; in[1].type = INPUT_MOUSE; in[1].mi.dwFlags = MOUSEEVENTF_LEFTUP;
    SendInput(2, in, sizeof(INPUT)); Sleep(300);
    memset(in, 0, sizeof in); in[0].type = INPUT_KEYBOARD; in[0].ki.wVk = VK_RETURN; in[1].type = INPUT_KEYBOARD; in[1].ki.wVk = VK_RETURN; in[1].ki.dwFlags = KEYEVENTF_KEYUP;
    SendInput(2, in, sizeof(INPUT));
  }
  wprintf(L"pressed Return in the directory box via %ls\n", viaInput ? L"input" : L"messages");
}
/* did a click do anything: the folder fills, a percent shows, a window came or went */
static int reacted(const DirStat *base, int visible0) {
  DirStat now = { 0, 0 }; statDir(g_dir, &now, 0);
  if (now.files > base->files || now.bytes > base->bytes) return 1;
  Watch w; memset(&w, 0, sizeof w); EnumWindows(watchTop, (LPARAM)&w);
  return w.visible != visible0 || w.pct[0] || w.done || w.finished;
}

static int usage(void) {
  wprintf(L"usage: dlgdrive.exe --dir \"Z:\\\\path\" [--button INSTALL] [--click 0.45,0.88] [--wait-sec 180] [--timeout-sec 5400] [--keep-checks] [--dump]\n");
  return 1;
}

int wmain(int argc, wchar_t **argv) {
  setvbuf(stdout, NULL, _IONBF, 0);
  for (int i = 1; i < argc; i++) {
    const wchar_t *a = argv[i], *v = i + 1 < argc ? argv[i + 1] : NULL;
    if (!wcscmp(a, L"--dir") && v) { g_dir = v; i++; }
    else if (!wcscmp(a, L"--button") && v) { wcsncpy(g_button, v, 63); for (wchar_t *s = g_button; *s; s++) *s = (wchar_t)towupper(*s); i++; }
    else if (!wcscmp(a, L"--click") && v) { if (swscanf(v, L"%lf,%lf", &g_cx, &g_cy) != 2) return usage(); i++; }
    else if (!wcscmp(a, L"--wait-sec") && v) { g_wait = _wtoi(v); i++; }
    else if (!wcscmp(a, L"--timeout-sec") && v) { g_timeout = _wtoi(v); i++; }
    else if (!wcscmp(a, L"--keep-checks")) g_keep = 1;
    else if (!wcscmp(a, L"--dump")) g_dump = 1;
    else if (!wcscmp(a, L"--probe")) g_probe = 1;
    else if (!wcscmp(a, L"--shot") && v) { g_shot = v; i++; }
    else return usage();
  }
  if (g_dump) { dump(); return 0; }
  if (!g_dir && !g_probe && !g_shot) return usage();

  /* 1. find the installer's window: a dialog with a real button wins; a custom window counts after a short grace */
  DWORD t0 = GetTickCount();
  Scene s; int custom = 0;
  for (;;) {
    memset(&s, 0, sizeof s);
    EnumWindows(pickTop, (LPARAM)&s);
    if (s.dialog.button) break;
    if (s.custom.wnd && GetTickCount() - t0 > 8000) { custom = 1; break; }
    if (GetTickCount() - t0 > (DWORD)g_wait * 1000) { wprintf(L"no installer window appeared in %d s\n", g_wait); dump(); return 2; }
    Sleep(1000);
  }
  Pick p = custom ? s.custom : s.dialog;
  wchar_t title[512], cls[64]; textOf(p.wnd, title, 512); GetClassNameW(p.wnd, cls, 64);
  RECT rc; GetWindowRect(p.wnd, &rc);
  wprintf(L"%ls window %ls %ldx%ld '%ls' (%d buttons, %d edit boxes)\n", custom ? L"custom" : L"dialog", cls, rc.right - rc.left, rc.bottom - rc.top, title, p.buttons, p.edits);
  Sleep(1500);
  if (p.edit) { RECT er; GetWindowRect(p.edit, &er); wprintf(L"edit box at %ld,%ld %ldx%ld (window-relative)\n", er.left - rc.left, er.top - rc.top, er.right - er.left, er.bottom - er.top); }
  if (g_shot) shot(p.wnd, g_shot);
  if (g_probe) { probe(p.wnd); return 0; }
  EnumChildWindows(p.wnd, fillChild, 0);
  Sleep(800);

  /* 2. press INSTALL */
  DirStat base = { 0, 0 }; statDir(g_dir, &base, 0);
  int visible0 = s.visible;
  if (!custom) {
    PostMessageW(p.button, BM_CLICK, 0, 0);
    wprintf(L"pressed '%ls'\n", g_button);
  } else {
    int hit = 0;
    if (p.edit) {                                                     /* read the box back (WM_GETTEXT: GetWindowText stays quiet across processes) */
      wchar_t now[1024] = L""; SendMessageW(p.edit, WM_GETTEXT, 1024, (LPARAM)now);
      if (_wcsicmp(now, g_dir) != 0) wprintf(L"warning: the directory box reads '%ls'\n", now);
    }
    if (p.edit && g_cx < 0) {
      for (int via = 0; via < 2 && !hit; via++) {
        pressReturnIn(p.edit, p.wnd, via);
        for (int t = 0; t < 8 && !hit; t++) { Sleep(1500); if (reacted(&base, visible0)) hit = 1; }
      }
    }
    if (!hit) {                                                       /* the painted INSTALL button of the older build */
      static const double cand[][2] = { { 0.44, 0.86 }, { 0.45, 0.88 }, { 0.46, 0.90 }, { 0.42, 0.88 }, { 0.48, 0.89 } };
      int n = g_cx >= 0 ? 1 : (int)(sizeof cand / sizeof cand[0]);
      for (int i = 0; i < n && !hit; i++) {
        for (int via = 0; via < 2 && !hit; via++) {
          if (!IsWindow(p.wnd)) { hit = 1; break; }                      /* it reacted by closing the window: the wait loop judges */
          clickAt(p.wnd, g_cx >= 0 ? g_cx : cand[i][0], g_cy >= 0 ? g_cy : cand[i][1], via);
          for (int t = 0; t < 8 && !hit; t++) { Sleep(1500); if (reacted(&base, visible0)) hit = 1; }
        }
      }
    }
    if (!hit) { wprintf(L"nothing reacted\n"); dump(); return 2; }
    wprintf(L"the installer reacted — installing\n");
  }

  /* 3. wait for the end */
  t0 = GetTickCount();
  wchar_t last[64] = L"", buf[32];
  unsigned long long lastBytes = 0; DWORD lastGrow = GetTickCount(), lastSay = 0;
  int answered = 0, okClicked = 0;
  for (;;) {
    Sleep(2000);
    Watch w; memset(&w, 0, sizeof w);
    EnumWindows(watchTop, (LPARAM)&w);
    DirStat now = { 0, 0 }; statDir(g_dir, &now, 0);
    if (now.bytes != lastBytes) { lastBytes = now.bytes; lastGrow = GetTickCount(); }
    if (w.pct[0] && wcscmp(w.pct, last)) { wcscpy(last, w.pct); wprintf(L"%ls\n", w.pct); }
    else if (custom && GetTickCount() - lastSay > 15000 && now.bytes) { lastSay = GetTickCount(); wprintf(L"%ls written\n", gb(now.bytes, buf)); }
    if (w.yesBtn && answered < 3) { PostMessageW(w.yesBtn, BM_CLICK, 0, 0); answered++; wprintf(L"answered yes\n"); continue; }
    if (w.visible == 0) { wprintf(L"the installer closed (%ls written)\n", gb(now.bytes, buf)); return 0; }
    int quiet = (int)((GetTickCount() - lastGrow) / 1000);
    int secondWindow = custom && w.visible > visible0 && now.bytes && quiet >= 10;         /* the done message over a custom installer */
    int wentQuiet = custom && now.bytes && quiet >= 90;                                     /* nothing written for a minute and a half: it is done and sitting there */
    if (w.done || w.finished || secondWindow || wentQuiet) {
      if (w.okBtn && !okClicked) { PostMessageW(w.okBtn, BM_CLICK, 0, 0); okClicked = 1; Sleep(1500); }
      wprintf(L"the installer reports %ls (%ls written)\n", w.done ? L"100%" : w.finished ? L"completion" : secondWindow ? L"done (a second window)" : L"done (the folder stopped growing)", gb(now.bytes, buf));
      return 0;
    }
    if ((GetTickCount() - t0) / 1000 > (DWORD)g_timeout) { wprintf(L"timed out after %d s (last progress: %ls, %ls written)\n", g_timeout, last[0] ? last : L"none", gb(now.bytes, buf)); dump(); return 3; }
  }
}

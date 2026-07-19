#!/usr/bin/env python3
"""VPS stealth login for session-binding sub2api panels (e.g. 章泓)."""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path
from typing import Any

os.environ.setdefault(
    "PLAYWRIGHT_BROWSERS_PATH",
    "/var/lib/group-price-fetcher/ms-playwright",
)

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright

try:
    from playwright_stealth import Stealth
except Exception:  # pragma: no cover
    Stealth = None


def env(name: str, default: str = "") -> str:
    return str(os.environ.get(name, default) or "")


def log(obj: Any) -> None:
    if isinstance(obj, (dict, list)):
        print(json.dumps(obj, ensure_ascii=False, indent=2), flush=True)
    else:
        print(str(obj), flush=True)


def extract_token_from_page(page) -> str:
    return page.evaluate(
        """() => {
      const bag = { ...localStorage, ...sessionStorage };
      const prefer = ['auth_token', 'access_token', 'token'];
      for (const k of prefer) {
        const v = bag[k];
        if (typeof v === 'string' && v.startsWith('eyJ')) return v;
      }
      for (const k of Object.keys(bag)) {
        const v = bag[k];
        if (typeof v === 'string' && v.startsWith('eyJ')) return v;
        try {
          const o = JSON.parse(v);
          const t = o.access_token || o.token || o.accessToken || o?.data?.access_token;
          if (t && String(t).startsWith('eyJ')) return String(t);
        } catch {}
      }
      return '';
    }"""
    )


def wait_turnstile_ready(page, timeout_ms: int = 120000) -> dict:
    start = time.time()
    last = {"hasWidget": False, "tokenLen": 0, "inputCount": 0}
    while (time.time() - start) * 1000 < timeout_ms:
        last = page.evaluate(
            """() => {
          const inputs = [...document.querySelectorAll('input')];
          const resp = document.querySelector('input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"]');
          const token = resp && resp.value ? String(resp.value) : '';
          const hasWidget = !!(
            document.querySelector('.cf-turnstile, [data-sitekey], iframe[src*="challenges.cloudflare"], iframe[src*="turnstile"]')
            || resp
          );
          const email = inputs.find(i => /email|user|mail/i.test((i.type||'')+(i.name||'')+(i.placeholder||''))) || inputs[0];
          const pass = inputs.find(i => i.type === 'password');
          return {
            hasWidget,
            tokenLen: token.length,
            inputCount: inputs.length,
            emailDisabled: !!(email && email.disabled),
            passDisabled: !!(pass && pass.disabled),
            href: location.href,
            body: (document.body && document.body.innerText || '').slice(0, 240)
          };
        }"""
        )
        if last.get("tokenLen", 0) > 20:
            return {**last, "ready": True, "reason": "token"}
        if (
            last.get("inputCount", 0) >= 2
            and not last.get("emailDisabled")
            and not last.get("passDisabled")
            and not last.get("hasWidget")
        ):
            return {**last, "ready": True, "reason": "inputs-enabled"}
        page.wait_for_timeout(1000)
    return {**last, "ready": False, "reason": "timeout"}


def try_click_turnstile(page) -> None:
    try:
        loc = page.locator(".cf-turnstile, [data-sitekey]").first
        if loc.count() > 0:
            box = loc.bounding_box()
            if box:
                page.mouse.click(box["x"] + min(30, box["width"] / 2), box["y"] + box["height"] / 2)
                page.wait_for_timeout(1500)
    except Exception:
        pass
    try:
        for frame in page.frames:
            url = frame.url or ""
            if "challenges.cloudflare" in url or "turnstile" in url:
                cb = frame.locator("input[type=checkbox], body")
                if cb.count() > 0:
                    cb.first.click(timeout=2000, force=True)
                    page.wait_for_timeout(1500)
                    break
    except Exception:
        pass


def login_once(base_url: str, email: str, password: str, profile_dir: Path, headless: bool = True) -> dict:
    base = base_url.rstrip("/")
    profile_dir.mkdir(parents=True, exist_ok=True)
    storage_path = profile_dir / "storage.json"

    with sync_playwright() as p:
        context_kwargs = {
            "user_agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/122.0.0.0 Safari/537.36"
            ),
            "locale": "zh-CN",
            "viewport": {"width": 1360, "height": 860},
            "timezone_id": "Asia/Shanghai",
        }
        if storage_path.exists():
            context_kwargs["storage_state"] = str(storage_path)

        browser = p.chromium.launch(
            headless=headless,
            args=[
                "--no-sandbox",
                "--disable-dev-shm-usage",
                "--disable-gpu",
                "--disable-blink-features=AutomationControlled",
            ],
        )
        context = browser.new_context(**context_kwargs)

        if Stealth is not None:
            stealth = Stealth(
                navigator_languages_override=("zh-CN", "zh"),
                navigator_platform_override="Win32",
            )
            try:
                stealth.apply_stealth_sync(context)
            except Exception:
                try:
                    stealth.apply_stealth_sync(browser)
                except Exception as e:
                    log({"warn": f"stealth apply failed: {e}"})

        page = context.new_page()
        page.set_default_timeout(60000)
        page.goto(base + "/", wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(1500)
        page.goto(base + "/login", wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(2000)
        page.wait_for_selector("input", timeout=30000)

        state = wait_turnstile_ready(page, timeout_ms=30000)
        if not state.get("ready"):
            try_click_turnstile(page)
            state = wait_turnstile_ready(page, timeout_ms=90000)

        fill_js = """({ email, password }) => {
          const setNative = (el, value) => {
            const proto = el.tagName === 'INPUT' ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype;
            const desc = Object.getOwnPropertyDescriptor(proto, 'value');
            desc.set.call(el, value);
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          };
          const inputs = [...document.querySelectorAll('input')];
          const pass = inputs.find(i => i.type === 'password') || inputs[1];
          const mail = inputs.find(i => i !== pass && (i.type === 'email' || i.type === 'text' || !i.type)) || inputs[0];
          if (!mail || !pass) return { ok:false, reason:'inputs-not-found', count: inputs.length };
          if (mail.disabled || pass.disabled) return { ok:false, reason:'inputs-disabled', count: inputs.length };
          setNative(mail, email);
          setNative(pass, password);
          for (const c of document.querySelectorAll('input[type=checkbox]')) {
            if (!c.checked) {
              try { c.click(); } catch {}
              c.dispatchEvent(new Event('change', { bubbles: true }));
            }
          }
          return { ok:true, count: inputs.length, mailLen: (mail.value||'').length, passLen: (pass.value||'').length };
        }"""
        filled = page.evaluate(fill_js, {"email": email, "password": password})
        if not filled.get("ok"):
            try_click_turnstile(page)
            state = wait_turnstile_ready(page, timeout_ms=60000)
            filled = page.evaluate(fill_js, {"email": email, "password": password})

        api_result = page.evaluate(
            """async ({ email, password }) => {
          const pub = await fetch('/api/v1/settings/public', { headers: { Accept: 'application/json' } })
            .then(r => r.json()).catch(() => ({}));
          const revision = pub?.data?.login_agreement_revision || pub?.data?.loginAgreementRevision || '';
          const respEl = document.querySelector('input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"]');
          const turnstile = respEl && respEl.value ? respEl.value : '';
          const body = { email, password };
          if (revision !== '' && revision != null) body.login_agreement_revision = revision;
          if (turnstile) {
            body.turnstile_token = turnstile;
            body['cf-turnstile-response'] = turnstile;
            body.captcha_token = turnstile;
          }
          const r = await fetch('/api/v1/auth/login', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
              'Accept-Language': 'zh'
            },
            body: JSON.stringify(body)
          });
          const j = await r.json().catch(() => ({}));
          return {
            status: r.status,
            code: j.code,
            message: j.message,
            reason: j.reason,
            hasToken: !!(j?.data?.access_token || j?.data?.token || j?.data?.accessToken),
            accessToken: j?.data?.access_token || j?.data?.token || j?.data?.accessToken || '',
            refreshToken: j?.data?.refresh_token || j?.data?.refreshToken || '',
            turnstileLen: turnstile.length,
            revision
          };
        }""",
            {"email": email, "password": password},
        )

        token = api_result.get("accessToken") or ""
        refresh = api_result.get("refreshToken") or ""

        if not token:
            try:
                btn = page.locator("button:has-text('登录'), button:has-text('Login'), input[type=submit]").first
                if btn.count() > 0:
                    btn.click(timeout=3000)
                else:
                    page.keyboard.press("Enter")
            except Exception:
                page.keyboard.press("Enter")
            for _ in range(40):
                page.wait_for_timeout(1000)
                token = extract_token_from_page(page) or ""
                if token:
                    break

        me = None
        if token:
            me = page.evaluate(
                """async (tok) => {
              const r = await fetch('/api/v1/auth/me', {
                headers: { Authorization: 'Bearer ' + tok, Accept: 'application/json' }
              });
              const j = await r.json().catch(() => ({}));
              return {
                status: r.status,
                code: j.code,
                message: j.message,
                balance: j?.data?.balance ?? j?.data?.quota ?? null,
                email: j?.data?.email || null
              };
            }""",
                token,
            )
            try:
                page.evaluate(
                    """(tok) => {
                  try { localStorage.setItem('auth_token', tok); } catch {}
                  try { localStorage.setItem('access_token', tok); } catch {}
                }""",
                    token,
                )
                context.storage_state(path=str(storage_path))
            except Exception:
                pass

        result = {
            "ok": bool(token and me and me.get("code") == 0),
            "filled": filled,
            "turnstileWait": state,
            "apiLogin": {k: v for k, v in api_result.items() if k not in ("accessToken", "refreshToken")},
            "hasToken": bool(token),
            "me": me,
            "profileDir": str(profile_dir),
            "href": page.url,
            "accessToken": token,
            "refreshToken": refresh,
        }
        if token:
            print("TOKEN_START", flush=True)
            print(json.dumps({"accessToken": token, "refreshToken": refresh}, ensure_ascii=False), flush=True)
            print("TOKEN_END", flush=True)
        browser.close()
        return result


def import_to_gpf(site_id: int, token: str, email: str = "", api: str = "http://127.0.0.1:5177") -> dict:
    import urllib.error
    import urllib.request

    def call(method: str, path: str, body=None, timeout=300):
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(
            api + path,
            data=data,
            method=method,
            headers={"Content-Type": "application/json", "Accept": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.status, json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            raw = e.read().decode(errors="replace")
            try:
                payload = json.loads(raw)
            except Exception:
                payload = raw
            return e.code, payload

    payload = {"authMode": "sub2api-token", "accessToken": token, "refreshToken": ""}
    if email:
        payload["email"] = email
    put = call("PUT", f"/api/sites/{site_id}/credentials", payload)
    login = call("POST", f"/api/sites/{site_id}/login", timeout=300)
    try:
        refresh = call("POST", f"/api/sites/{site_id}/refresh", timeout=300)
    except Exception as e:
        refresh = (0, {"error": str(e)})
    _st, site = call("GET", f"/api/sites/{site_id}")
    return {
        "put": put[0],
        "login": login[1] if isinstance(login[1], dict) else login,
        "refresh": refresh[1] if isinstance(refresh[1], dict) else refresh,
        "site": {
            "authStatus": site.get("authStatus"),
            "authError": site.get("authError") or "",
            "balanceUsd": site.get("balanceUsd"),
            "lastCollectedAt": site.get("lastCollectedAt"),
            "gptGroup": site.get("gptCurrentRateGroupName"),
            "gptRate": site.get("gptCurrentRateMultiplier"),
        },
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", default=env("BASE_URL", "https://api-provider.uling19.com"))
    ap.add_argument("--email", default=env("EMAIL"))
    ap.add_argument("--password", default=env("PASSWORD"))
    ap.add_argument(
        "--profile-dir",
        default=env(
            "PROFILE_DIR",
            "/var/lib/group-price-fetcher/playwright-profiles/stealth-zhanghong",
        ),
    )
    ap.add_argument("--site-id", type=int, default=int(env("SITE_ID", "0") or "0"))
    ap.add_argument("--import-gpf", action="store_true")
    ap.add_argument("--headed", action="store_true")
    args = ap.parse_args()

    if not args.email or not args.password:
        log({"ok": False, "error": "EMAIL/PASSWORD required"})
        return 2

    result = login_once(
        base_url=args.base_url,
        email=args.email,
        password=args.password,
        profile_dir=Path(args.profile_dir),
        headless=not args.headed,
    )
    safe = {k: v for k, v in result.items() if k not in ("accessToken", "refreshToken")}
    log({"loginResult": safe})

    if args.import_gpf and args.site_id and result.get("accessToken"):
        imp = import_to_gpf(args.site_id, result["accessToken"], email=args.email)
        log({"import": imp})
        return 0 if imp.get("site", {}).get("authStatus") == "valid" else 4

    return 0 if result.get("ok") else 3


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except PlaywrightTimeoutError as e:
        log({"ok": False, "error": f"timeout: {e}"})
        raise SystemExit(1)
    except Exception as e:
        log({"ok": False, "error": str(e)})
        raise SystemExit(1)

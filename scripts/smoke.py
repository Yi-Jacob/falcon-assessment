"""Local smoke test against http://localhost:3111 (run after `npm run build && next start -p 3111`)."""
import hashlib, hmac, os, re, urllib.request

SECRET = os.environ.get("SESSION_SECRET", "dev-only-mock-secret-change-me").encode()
def cookie(u): return f"falcon_session={u}.{hmac.new(SECRET, u.encode(), hashlib.sha256).hexdigest()}"
def get(c):
    return urllib.request.urlopen(urllib.request.Request("http://localhost:3111/", headers={"Cookie": c})).read().decode()

for u in ["ops", "dana"]:
    h = get(cookie(u))
    total = re.search(r"Grand total.*?<b>(\$[^<]+)</b>", h, re.S)
    print(u, "exception rows:", len(re.findall(r'class="tag', h)), "| total:", total.group(1) if total else None,
          "| audit log shown:", "Audit log" in h, "| approve buttons:", "Approve" in h)
h = urllib.request.urlopen(urllib.request.Request("http://localhost:3111/", headers={"Cookie": "falcon_session=ops.bad"})).read().decode()
print("forged cookie page is login redirect:", "Sign in (mock)" in h)

"""Local smoke test against http://localhost:3111 (run after `npm run build && next start -p 3111`)."""
import hashlib, hmac, re, urllib.request

SECRET = b"dev-only-mock-secret-change-me"
def cookie(u): return f"falcon_session={u}.{hmac.new(SECRET, u.encode(), hashlib.sha256).hexdigest()}"
def get(c):
    return urllib.request.urlopen(urllib.request.Request("http://localhost:3111/", headers={"Cookie": c})).read().decode()

for u in ["ops", "dana"]:
    h = get(cookie(u))
    print(u, "exception rows:", len(re.findall(r'class="tag', h)), "| total:", re.findall(r"Grand total[^<]*<b>([^<]*)", h)[:1],
          "| audit log shown:", "Audit log" in h, "| approve buttons:", "Approve" in h)
h = urllib.request.urlopen(urllib.request.Request("http://localhost:3111/", headers={"Cookie": "falcon_session=ops.bad"})).read().decode()
print("forged cookie page is login redirect:", "Sign in (mock)" in h)

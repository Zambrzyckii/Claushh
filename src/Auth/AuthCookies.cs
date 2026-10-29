// Names and attributes of the auth cookies: the session, antiforgery and XSRF cookies, and the pending passkey login's
// challenge (docs/ARCHITECTURE.md, "Backend").
using Microsoft.Extensions.Options;

namespace Claushh.Api.Auth;

public sealed class AuthCookies(IOptions<AuthSessionOptions> options)
{
    // The name Angular's XSRF support reads.
    public const string XsrfToken = "XSRF-TOKEN";

    public bool SecureRequired => options.Value.SecureCookies;
    public string Session => SecureRequired ? "__Host-claushh-session" : "claushh-session";
    public string Antiforgery => SecureRequired ? "__Host-claushh-af" : "claushh-af";
    public string Passkey => SecureRequired ? "__Host-claushh-passkey" : "claushh-passkey";

    // No Expires: the browser drops the cookie when it closes; the server enforces both deadlines.
    public void AppendSession(HttpResponse response, string secret) =>
        response.Cookies.Append(Session, secret, Options(response, httpOnly: true));

    public void AppendXsrfToken(HttpResponse response, string token) =>
        response.Cookies.Append(XsrfToken, token, Options(response, httpOnly: false));

    // The id of a pending passkey login challenge; it lasts as long as the challenge (PasskeyCeremonies.Lifetime).
    public void AppendPasskeyChallenge(HttpResponse response, string id)
    {
        var cookie = Options(response, httpOnly: true);
        cookie.MaxAge = PasskeyCeremonies.Lifetime;
        response.Cookies.Append(Passkey, id, cookie);
    }

    public void ExpirePasskeyChallenge(HttpResponse response) =>
        response.Cookies.Delete(Passkey, Options(response, httpOnly: true));

    // The same Secure and Path as when setting: browsers ignore a __Host- deletion without them.
    public void ExpireAll(HttpResponse response)
    {
        response.Cookies.Delete(Session, Options(response, httpOnly: true));
        response.Cookies.Delete(Antiforgery, Options(response, httpOnly: true));
        response.Cookies.Delete(XsrfToken, Options(response, httpOnly: false));
    }

    private CookieOptions Options(HttpResponse response, bool httpOnly) => new()
    {
        HttpOnly = httpOnly,
        Secure = SecureRequired || response.HttpContext.Request.IsHttps,
        SameSite = SameSiteMode.Strict,
        Path = "/",
    };
}

// Names and attributes of the three auth cookies (docs/ARCHITECTURE.md, "Backend").
using Microsoft.Extensions.Options;

namespace Claushh.Api.Auth;

public sealed class AuthCookies(IOptions<AuthSessionOptions> options)
{
    // The name Angular's XSRF support reads.
    public const string XsrfToken = "XSRF-TOKEN";

    public bool SecureRequired => options.Value.SecureCookies;
    public string Session => SecureRequired ? "__Host-claushh-session" : "claushh-session";
    public string Antiforgery => SecureRequired ? "__Host-claushh-af" : "claushh-af";

    // No Expires: the browser drops the cookie when it closes; the server enforces both deadlines.
    public void AppendSession(HttpResponse response, string secret) =>
        response.Cookies.Append(Session, secret, Options(response, httpOnly: true));

    public void AppendXsrfToken(HttpResponse response, string token) =>
        response.Cookies.Append(XsrfToken, token, Options(response, httpOnly: false));

    private CookieOptions Options(HttpResponse response, bool httpOnly) => new()
    {
        HttpOnly = httpOnly,
        Secure = SecureRequired || response.HttpContext.Request.IsHttps,
        SameSite = SameSiteMode.Strict,
        Path = "/",
    };
}

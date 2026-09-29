// Turns the session cookie into a user (docs/ARCHITECTURE.md, "Backend").
// It never extends a session: only POST /api/auth/keepalive does.
using System.Security.Claims;
using System.Text.Encodings.Web;
using Microsoft.AspNetCore.Authentication;
using Microsoft.Extensions.Options;

namespace Claushh.Api.Auth;

public sealed class SessionAuthenticationHandler(
    IOptionsMonitor<AuthenticationSchemeOptions> options,
    ILoggerFactory logger,
    UrlEncoder encoder,
    SessionService sessions,
    AuthCookies cookies)
    : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder)
{
    public const string SchemeName = "Session";
    public const string SessionIdClaim = "session_id";

    // The session loaded by this handler, for endpoints that require one (the fallback policy guarantees it is there).
    public static Session Current(HttpContext http) =>
        http.Features.Get<Session>() ?? throw new InvalidOperationException("The endpoint requires a session.");

    protected override async Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        if (!Request.Cookies.TryGetValue(cookies.Session, out var secret))
        {
            return AuthenticateResult.NoResult();
        }
        var session = await sessions.FindActiveAsync(secret, Context.RequestAborted);
        if (session is null)
        {
            return AuthenticateResult.NoResult();
        }
        // Endpoints read the loaded session from here instead of querying it again.
        Context.Features.Set(session);
        var identity = new ClaimsIdentity(
            [
                new Claim(ClaimTypes.NameIdentifier, session.UserId),
                new Claim(ClaimTypes.Name, session.User.UserName!),
                new Claim(SessionIdClaim, session.Id.ToString()),
            ],
            SchemeName);
        return AuthenticateResult.Success(new AuthenticationTicket(new ClaimsPrincipal(identity), SchemeName));
    }
}

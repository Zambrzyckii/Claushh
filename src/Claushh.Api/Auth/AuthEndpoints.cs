// Login API from docs/ARCHITECTURE.md, "Authentication" → "API contract"; sessions and cookies: "Backend".
using Microsoft.AspNetCore.Antiforgery;
using Microsoft.AspNetCore.Identity;

namespace Claushh.Api.Auth;

public static class AuthEndpoints
{
    public sealed record LoginRequest(string? UserName, string? Password, string? TotpCode);
    public sealed record MeResponse(string UserName, Guid SessionId, int ExpiresIn, int AbsoluteExpiresIn);

    private static readonly IdentityUser DummyUser = new();
    private static string? _dummyHash;

    public static RouteGroupBuilder MapAuthEndpoints(this RouteGroupBuilder api)
    {
        var auth = api.MapGroup("/auth");
        auth.MapGet("/me", Me).AllowAnonymous();
        auth.MapPost("/login", Login).AllowAnonymous();
        return api;
    }

    // Every state-changing request needs a valid XSRF token (GET, HEAD, OPTIONS and TRACE pass through).
    // Runs after authentication, because the token is bound to the identity.
    public static RouteGroupBuilder RequireXsrfToken(this RouteGroupBuilder api)
    {
        api.AddEndpointFilter(async (context, next) =>
        {
            var http = context.HttpContext;
            var antiforgery = http.RequestServices.GetRequiredService<IAntiforgery>();
            return await antiforgery.IsRequestValidAsync(http) ? await next(context) : Results.BadRequest();
        });
        return api;
    }

    private static IResult Me(HttpContext http, IAntiforgery antiforgery, AuthCookies cookies, SessionService sessions)
    {
        // Always a fresh token for the current identity, also on 401: the login needs it.
        cookies.AppendXsrfToken(http.Response, antiforgery.GetAndStoreTokens(http).RequestToken!);
        if (http.Features.Get<Session>() is not { } session)
        {
            return Results.Unauthorized();
        }
        var (expiresIn, absoluteExpiresIn) = sessions.SecondsLeft(session);
        return Results.Ok(new MeResponse(session.User.UserName!, session.Id, expiresIn, absoluteExpiresIn));
    }

    private static async Task<IResult> Login(LoginRequest body, HttpContext http, UserManager<IdentityUser> users,
        SessionService sessions, AuthCookies cookies, ILoggerFactory loggers)
    {
        var log = loggers.CreateLogger("Claushh.Api.Auth.Login");
        var ip = http.Connection.RemoteIpAddress?.ToString() ?? "";
        var user = await VerifyAsync(users, body);
        if (user is null)
        {
            log.LogInformation("Failed login for {UserName} from {Ip}", body.UserName, ip);
            return Results.Unauthorized();
        }
        var (_, secret) = await sessions.CreateAsync(user, http.Request.Headers.UserAgent.ToString(), ip, http.RequestAborted);
        cookies.AppendSession(http.Response, secret);
        log.LogInformation("Login of {UserName} from {Ip}", user.UserName, ip);
        return Results.NoContent();
    }

    // Null for every kind of failure. An unknown user still costs one password hash, so the response time
    // does not reveal whether the name exists.
    private static async Task<IdentityUser?> VerifyAsync(UserManager<IdentityUser> users, LoginRequest body)
    {
        if (body.UserName is not { Length: > 0 and <= 256 } userName
            || body.Password is not { Length: > 0 and <= 1024 } password
            || body.TotpCode is not { Length: 6 } totpCode)
        {
            return null;
        }
        var user = await users.FindByNameAsync(userName);
        if (user is null)
        {
            _dummyHash ??= users.PasswordHasher.HashPassword(DummyUser, "dummy password for timing");
            users.PasswordHasher.VerifyHashedPassword(DummyUser, _dummyHash, password);
            return null;
        }
        if (!user.TwoFactorEnabled || !await users.CheckPasswordAsync(user, password))
        {
            return null;
        }
        var codeValid = await users.VerifyTwoFactorTokenAsync(user, users.Options.Tokens.AuthenticatorTokenProvider, totpCode);
        return codeValid ? user : null;
    }
}

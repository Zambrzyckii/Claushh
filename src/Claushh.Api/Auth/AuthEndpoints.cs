// Login API from docs/ARCHITECTURE.md, "Authentication" → "API contract"; sessions and cookies: "Backend".
using System.Globalization;
using System.Text.Json;
using Microsoft.AspNetCore.Antiforgery;
using Microsoft.AspNetCore.Identity;

namespace Claushh.Api.Auth;

public static class AuthEndpoints
{
    public sealed record LoginRequest(string? UserName, string? Password, string? TotpCode);
    // A string, not a Guid: a marker that is not a GUID must give 409 like any other foreign session, not 400.
    public sealed record LogoutRequest(string? SessionId);
    public sealed record MeResponse(string UserName, Guid SessionId, int ExpiresIn, int AbsoluteExpiresIn);
    public sealed record KeepaliveResponse(Guid SessionId, int ExpiresIn, int AbsoluteExpiresIn);

    private static readonly IdentityUser DummyUser = new();
    private static string? _dummyHash;

    public static RouteGroupBuilder MapAuthEndpoints(this RouteGroupBuilder api)
    {
        var auth = api.MapGroup("/auth");
        auth.MapGet("/me", Me).AllowAnonymous();
        auth.MapPost("/login", Login).AllowAnonymous();
        auth.MapPost("/keepalive", Keepalive);
        auth.MapPost("/logout", Logout);
        auth.MapDelete("/sessions/{id:guid}", EndSession);
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
        LoginGuard guard, TotpVerifier totp, SessionService sessions, AuthCookies cookies, ILoggerFactory loggers)
    {
        var log = loggers.CreateLogger("Claushh.Api.Auth.Login");
        var ip = http.Connection.RemoteIpAddress?.ToString() ?? "";
        var userAgent = http.Request.Headers.UserAgent.ToString();
        using var gate = await guard.EnterAsync(http.RequestAborted);
        if (await guard.RetryAfterAsync(ip, http.RequestAborted) is { } retryAfter)
        {
            http.Response.Headers.RetryAfter = retryAfter.ToString(CultureInfo.InvariantCulture);
            return Results.StatusCode(StatusCodes.Status429TooManyRequests);
        }
        // CheckPasswordAsync returns a user only when TotpCode has 6 characters.
        var user = await CheckPasswordAsync(users, body);
        var success = user is not null && await totp.VerifyAsync(user, body.TotpCode!);
        await guard.RecordAsync(success, ip, userAgent, http.RequestAborted);
        if (user is null || !success)
        {
            if (user is not null)
            {
                // The password was right: only wrong or reused codes count towards the lockout.
                await guard.CodeFailedAsync(user);
            }
            // No user name: it is unvalidated input (newlines, any length, sometimes a mistyped password).
            log.LogInformation("Failed login from {Ip}", ip);
            return Results.Unauthorized();
        }
        await guard.SucceededAsync(user);
        var (_, secret) = await sessions.CreateAsync(user, userAgent, ip, http.RequestAborted);
        cookies.AppendSession(http.Response, secret);
        log.LogInformation("Login of {UserName} from {Ip}", user.UserName, ip);
        return Results.NoContent();
    }

    private static async Task<IResult> Keepalive(HttpContext http, SessionService sessions)
    {
        var session = CurrentSession(http);
        await sessions.ExtendAsync(session, http.RequestAborted);
        var (expiresIn, absoluteExpiresIn) = sessions.SecondsLeft(session);
        return Results.Ok(new KeepaliveResponse(session.Id, expiresIn, absoluteExpiresIn));
    }

    // Without a body the session from the cookie ends. With {sessionId} only if the cookie still belongs to it,
    // so a late retry does not end a newer session (docs/ARCHITECTURE.md, "Rules").
    // The body is read by hand: an inferred JSON body makes routing skip this endpoint for a POST without Content-Type,
    // and the catch-all /api route would answer 404.
    private static async Task<IResult> Logout(HttpContext http, SessionService sessions, AuthCookies cookies)
    {
        var session = CurrentSession(http);
        LogoutRequest? body;
        try
        {
            body = http.Request.HasJsonContentType()
                ? await http.Request.ReadFromJsonAsync<LogoutRequest>(http.RequestAborted)
                : null;
        }
        catch (JsonException)
        {
            return Results.BadRequest();
        }
        if (body?.SessionId is { } requested && (!Guid.TryParse(requested, out var id) || id != session.Id))
        {
            return Results.Conflict();
        }
        await sessions.RevokeAsync(session.Id, session.UserId, http.RequestAborted);
        cookies.ExpireAll(http.Response);
        return Results.NoContent();
    }

    // 404 also for ended and expired sessions: the frontend reads it as "already gone" (auth.service.ts, endSession).
    private static async Task<IResult> EndSession(Guid id, HttpContext http, SessionService sessions)
    {
        var current = CurrentSession(http);
        if (id == current.Id)
        {
            return Results.BadRequest();
        }
        return await sessions.RevokeAsync(id, current.UserId, http.RequestAborted) ? Results.NoContent() : Results.NotFound();
    }

    // The user when the fields have valid lengths, the name and password are right and TOTP is on; null otherwise.
    // An unknown user still costs one password hash, so the response time does not reveal whether the name exists.
    private static async Task<IdentityUser?> CheckPasswordAsync(UserManager<IdentityUser> users, LoginRequest body)
    {
        if (body.UserName is not { Length: > 0 and <= 256 } userName
            || body.Password is not { Length: > 0 and <= 1024 } password
            || body.TotpCode is not { Length: 6 })
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
        return user.TwoFactorEnabled && await users.CheckPasswordAsync(user, password) ? user : null;
    }

    private static Session CurrentSession(HttpContext http) =>
        http.Features.Get<Session>() ?? throw new InvalidOperationException("The endpoint requires a session.");
}

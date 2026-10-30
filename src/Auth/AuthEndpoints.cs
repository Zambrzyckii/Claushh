// Login API from docs/ARCHITECTURE.md, "Authentication" → "API contract"; sessions and cookies: "Backend".
using System.Globalization;
using System.Text.Json;
using Claushh.Api.Auth.Realtime;
using Microsoft.AspNetCore.Antiforgery;

namespace Claushh.Api.Auth;

public static class AuthEndpoints
{
    public sealed record LoginRequest(string? UserName, string? Password, string? TotpCode);
    // A string, not a Guid: a marker that is not a GUID must give 409 like any other foreign session, not 400.
    public sealed record LogoutRequest(string? SessionId);
    public sealed record MeResponse(string UserName, Guid SessionId, int ExpiresIn, int AbsoluteExpiresIn);
    public sealed record KeepaliveResponse(Guid SessionId, int ExpiresIn, int AbsoluteExpiresIn);

    public static RouteGroupBuilder MapAuthEndpoints(this RouteGroupBuilder api)
    {
        var auth = api.MapGroup("/auth");
        auth.MapGet("/me", Me).AllowAnonymous();
        auth.MapPost("/login", Login).AllowAnonymous();
        auth.MapPost("/keepalive", Keepalive);
        auth.MapPost("/logout", Logout);
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

    private static async Task<IResult> Login(LoginRequest body, HttpContext http, SignIn signIn, AuthCookies cookies)
    {
        // After ForwardedHeaders: behind the tunnel, the address from CF-Connecting-IP.
        var outcome = await signIn.PasswordAsync(LoginClient.From(http), body.UserName, body.Password, body.TotpCode,
            http.RequestAborted);
        switch (outcome.Status)
        {
            case SignInStatus.TooMany:
                http.Response.Headers.RetryAfter = outcome.RetryAfter.ToString(CultureInfo.InvariantCulture);
                return Results.StatusCode(StatusCodes.Status429TooManyRequests);
            case SignInStatus.Failed:
                return Results.Unauthorized();
            default:
                cookies.AppendSession(http.Response, outcome.Secret!);
                return Results.NoContent();
        }
    }

    private static async Task<IResult> Keepalive(HttpContext http, SessionService sessions)
    {
        var session = SessionAuthenticationHandler.Current(http);
        await sessions.ExtendAsync(session, http.RequestAborted);
        var (expiresIn, absoluteExpiresIn) = sessions.SecondsLeft(session);
        return Results.Ok(new KeepaliveResponse(session.Id, expiresIn, absoluteExpiresIn));
    }

    // Without a body the session from the cookie ends. With {sessionId} only if the cookie still belongs to it,
    // so a late retry does not end a newer session (docs/ARCHITECTURE.md, "Authentication" → "Rules").
    // The body is read by hand: an inferred JSON body makes routing skip this endpoint for a POST without Content-Type,
    // and the catch-all /api route would answer 404.
    private static async Task<IResult> Logout(HttpContext http, SessionService sessions, AuthCookies cookies, HubSessionSweep sweep)
    {
        var session = SessionAuthenticationHandler.Current(http);
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
        await sweep.CloseAfterRevocationAsync("Closing hub connections after logout failed");
        cookies.ExpireAll(http.Response);
        return Results.NoContent();
    }
}

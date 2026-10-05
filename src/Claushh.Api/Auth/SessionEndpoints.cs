// Session list, ending sessions and the login history for the security window
// (docs/ARCHITECTURE.md, "Authentication" → "Sessions and login history").
using Claushh.Api.Hubs;

namespace Claushh.Api.Auth;

public static class SessionEndpoints
{
    public sealed record SessionResponse(Guid Id, bool Current, string Device, string Ip, DateTimeOffset CreatedAt, DateTimeOffset LastActivityAt);
    public sealed record LoginAttemptResponse(DateTimeOffset At, string Ip, string Device, bool Success, string Method);

    public static RouteGroupBuilder MapSessionEndpoints(this RouteGroupBuilder api)
    {
        var auth = api.MapGroup("/auth");
        auth.MapGet("/sessions", List);
        auth.MapPost("/sessions/revoke-others", RevokeOthers);
        auth.MapDelete("/sessions/{id:guid}", EndSession);
        auth.MapGet("/logins", Logins);
        return api;
    }

    private static async Task<IResult> List(HttpContext http, SessionService sessions)
    {
        var current = SessionAuthenticationHandler.Current(http);
        var active = await sessions.ListActiveAsync(current.UserId, http.RequestAborted);
        return Results.Ok(active.Select(s => new SessionResponse(
            s.Id, s.Id == current.Id, DeviceName.From(s.Device), s.Ip, s.CreatedAt, s.LastActivityAt)));
    }

    private static async Task<IResult> RevokeOthers(HttpContext http, SessionService sessions, HubSessionSweep sweep,
        ILoggerFactory loggers)
    {
        await sessions.RevokeOthersAsync(SessionAuthenticationHandler.Current(http), http.RequestAborted);
        // A failure here must not turn the already-committed revocation into a 500: the 5 s timer closes the
        // connections anyway.
        try
        {
            await sweep.RunOnceAsync(CancellationToken.None);
        }
        catch (Exception e)
        {
            loggers.CreateLogger("Claushh.Api.Auth.RevokeOthers").LogError(e, "Closing hub connections after revoke-others failed");
        }
        return Results.NoContent();
    }

    // 404 also for ended and expired sessions: the frontend reads it as "already gone" (auth.service.ts, endSession).
    private static async Task<IResult> EndSession(Guid id, HttpContext http, SessionService sessions, HubSessionSweep sweep,
        ILoggerFactory loggers)
    {
        var current = SessionAuthenticationHandler.Current(http);
        if (id == current.Id)
        {
            return Results.BadRequest();
        }
        if (!await sessions.RevokeAsync(id, current.UserId, http.RequestAborted))
        {
            return Results.NotFound();
        }
        // Same as above: a failure here must not turn the already-committed revocation into a 500.
        try
        {
            await sweep.RunOnceAsync(CancellationToken.None);
        }
        catch (Exception e)
        {
            loggers.CreateLogger("Claushh.Api.Auth.EndSession").LogError(e, "Closing hub connections after ending a session failed");
        }
        return Results.NoContent();
    }

    private static async Task<IResult> Logins(HttpContext http, LoginGuard guard)
    {
        var attempts = await guard.RecentAsync(http.RequestAborted);
        return Results.Ok(attempts.Select(a => new LoginAttemptResponse(a.At, a.Ip, DeviceName.From(a.Device), a.Success, a.Method)));
    }
}

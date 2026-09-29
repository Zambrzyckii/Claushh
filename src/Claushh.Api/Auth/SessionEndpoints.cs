// Session list, ending sessions and the login history for the "Bezpieczeństwo" window
// (docs/ARCHITECTURE.md, "Authentication" → "Sessions and login history").
namespace Claushh.Api.Auth;

public static class SessionEndpoints
{
    public sealed record SessionResponse(Guid Id, bool Current, string Device, string Ip, DateTimeOffset CreatedAt, DateTimeOffset LastActivityAt);
    public sealed record LoginAttemptResponse(DateTimeOffset At, string Ip, string Device, bool Success);

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

    private static async Task<IResult> RevokeOthers(HttpContext http, SessionService sessions)
    {
        await sessions.RevokeOthersAsync(SessionAuthenticationHandler.Current(http), http.RequestAborted);
        return Results.NoContent();
    }

    // 404 also for ended and expired sessions: the frontend reads it as "already gone" (auth.service.ts, endSession).
    private static async Task<IResult> EndSession(Guid id, HttpContext http, SessionService sessions)
    {
        var current = SessionAuthenticationHandler.Current(http);
        if (id == current.Id)
        {
            return Results.BadRequest();
        }
        return await sessions.RevokeAsync(id, current.UserId, http.RequestAborted) ? Results.NoContent() : Results.NotFound();
    }

    private static async Task<IResult> Logins(HttpContext http, LoginGuard guard)
    {
        var attempts = await guard.RecentAsync(http.RequestAborted);
        return Results.Ok(attempts.Select(a => new LoginAttemptResponse(a.At, a.Ip, DeviceName.From(a.Device), a.Success)));
    }
}

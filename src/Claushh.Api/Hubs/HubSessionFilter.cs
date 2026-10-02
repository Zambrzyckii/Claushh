// Ties every hub connection to its session (docs/ARCHITECTURE.md, "Backend" → "Hubs"). SignalR checks the cookie only
// when the WebSocket opens, so this filter checks the session again on connect and on every call, and registers the
// connection so HubSessionSweep can close it when the session ends. It never extends the session.
using Claushh.Api.Auth;
using Microsoft.AspNetCore.SignalR;

namespace Claushh.Api.Hubs;

public sealed class HubSessionFilter(HubConnections connections) : IHubFilter
{
    public const string SessionEnded = "Sesja wygasła";

    public async Task OnConnectedAsync(HubLifetimeContext context, Func<HubLifetimeContext, Task> next)
    {
        var session = SessionOf(context.Context);
        if (session is { } id)
        {
            // Registered before the check: a session that ends between the two is still seen by the next sweep.
            connections.Add(id, context.Context);
        }
        if (session is not { } active
            || !await IsActiveAsync(context.ServiceProvider, active, context.Context.ConnectionAborted))
        {
            context.Context.Abort();
            return;
        }
        await next(context);
    }

    public async ValueTask<object?> InvokeMethodAsync(HubInvocationContext invocationContext,
        Func<HubInvocationContext, ValueTask<object?>> next)
    {
        var caller = invocationContext.Context;
        if (SessionOf(caller) is not { } session
            || !await IsActiveAsync(invocationContext.ServiceProvider, session, caller.ConnectionAborted))
        {
            caller.Abort();
            throw new HubException(SessionEnded);
        }
        return await next(invocationContext);
    }

    public Task OnDisconnectedAsync(HubLifetimeContext context, Exception? exception,
        Func<HubLifetimeContext, Exception?, Task> next)
    {
        if (SessionOf(context.Context) is { } session)
        {
            connections.Remove(session, context.Context);
        }
        return next(context, exception);
    }

    private static Guid? SessionOf(HubCallerContext caller) =>
        Guid.TryParse(caller.User?.FindFirst(SessionAuthenticationHandler.SessionIdClaim)?.Value, out var id) ? id : null;

    private static Task<bool> IsActiveAsync(IServiceProvider services, Guid session, CancellationToken ct) =>
        services.GetRequiredService<SessionService>().IsActiveAsync(session, ct);
}

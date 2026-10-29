// Closes the hub connections of sessions that ended (docs/ARCHITECTURE.md, "Backend" → "Hubs"): every 5 s, which
// catches expiry and create-user in another process, and right after a logout or revocation in this process. Tests
// call RunOnceAsync directly instead of waiting for the timer.

namespace Claushh.Api.Auth.Realtime;

public sealed class HubSessionSweep(HubConnections connections, IServiceScopeFactory scopes, TimeProvider clock,
    ILogger<HubSessionSweep> log) : BackgroundService
{
    private static readonly TimeSpan Interval = TimeSpan.FromSeconds(5);

    public async Task RunOnceAsync(CancellationToken ct)
    {
        var registered = connections.Sessions();
        if (registered.Length == 0)
        {
            return;
        }
        await using var scope = scopes.CreateAsyncScope();
        var active = await scope.ServiceProvider.GetRequiredService<SessionService>().ActiveIdsAsync(registered, ct);
        // Only the sessions asked about: one registered meanwhile waits for the next run.
        var closed = connections.Abort(registered.Except(active));
        if (closed > 0)
        {
            log.LogInformation("Closed {Count} hub connections of ended sessions", closed);
        }
    }

    public async Task CloseAfterRevocationAsync(string failureMessage)
    {
        // Its hub connections close now, not at the next sweep; also when the client has gone meanwhile. A failure
        // here must not turn the already-committed revocation into a 500, or skip expiring the cookies: the 5 s timer
        // closes the connections anyway.
        try
        {
            await RunOnceAsync(CancellationToken.None);
        }
        catch (Exception e)
        {
            log.LogError(e, failureMessage);
        }
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(Interval, clock);
        while (await timer.WaitForNextTickAsync(stoppingToken))
        {
            try
            {
                await RunOnceAsync(stoppingToken);
            }
            catch (Exception e) when (!stoppingToken.IsCancellationRequested)
            {
                // A failing background service stops the whole API; the next run is in 5 s.
                log.LogError(e, "Closing the hub connections of ended sessions failed");
            }
        }
    }
}

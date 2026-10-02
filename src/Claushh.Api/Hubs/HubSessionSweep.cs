// Closes the hub connections of sessions that ended (docs/ARCHITECTURE.md, "Backend" → "Hubs"): every 5 s, which
// catches expiry and create-user in another process, and right after a logout or revocation in this process. Tests
// call RunOnceAsync directly instead of waiting for the timer.
using Claushh.Api.Auth;

namespace Claushh.Api.Hubs;

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

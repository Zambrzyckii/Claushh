// Deletes console conversations, with their events, 90 days after their last event (docs/ARCHITECTURE.md, "Backend" →
// "Console"), at start and every hour; the "always" rules stay. Tests call RunOnceAsync directly.
namespace Claushh.Api.Claude;

public sealed class ConversationCleanup(ConversationLog store, TimeProvider clock, ILogger<ConversationCleanup> log) : BackgroundService
{
    public static readonly TimeSpan Retention = TimeSpan.FromDays(90);
    private static readonly TimeSpan Interval = TimeSpan.FromHours(1);

    public async Task RunOnceAsync(CancellationToken ct)
    {
        var deleted = await store.DeleteOlderThanAsync(clock.GetUtcNow() - Retention, ct);
        if (deleted > 0)
        {
            log.LogInformation("Cleanup deleted {Conversations} console conversations", deleted);
        }
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(Interval, clock);
        do
        {
            try
            {
                await RunOnceAsync(stoppingToken);
            }
            catch (Exception e) when (!stoppingToken.IsCancellationRequested)
            {
                // A failing background service would stop the whole API; a failed cleanup is not worth that.
                log.LogError(e, "Console cleanup failed; the next attempt is in an hour");
            }
        }
        while (await timer.WaitForNextTickAsync(stoppingToken));
    }
}

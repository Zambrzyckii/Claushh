// Deletes login attempts and ended sessions 90 days after they ended (docs/ARCHITECTURE.md, "Backend"), at start and
// every hour. Tests call RunOnceAsync directly instead of waiting for the timer.
namespace Claushh.Api.Auth;

public sealed class AuthCleanup(IServiceScopeFactory scopes, TimeProvider clock, ILogger<AuthCleanup> log) : BackgroundService
{
    private static readonly TimeSpan Retention = TimeSpan.FromDays(90);
    private static readonly TimeSpan Interval = TimeSpan.FromHours(1);

    public async Task RunOnceAsync(CancellationToken ct)
    {
        await using var scope = scopes.CreateAsyncScope();
        var cutoff = clock.GetUtcNow() - Retention;
        var sessions = await scope.ServiceProvider.GetRequiredService<SessionService>().DeleteEndedBeforeAsync(cutoff, ct);
        var attempts = await scope.ServiceProvider.GetRequiredService<LoginGuard>().DeleteAttemptsBeforeAsync(cutoff, ct);
        if (sessions + attempts > 0)
        {
            log.LogInformation("Cleanup deleted {Sessions} sessions and {Attempts} login attempts", sessions, attempts);
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
                // By default an exception in a background service stops the whole API; a failed cleanup is not worth that.
                log.LogError(e, "Cleanup failed; the next attempt is in an hour");
            }
        }
        while (await timer.WaitForNextTickAsync(stoppingToken));
    }
}

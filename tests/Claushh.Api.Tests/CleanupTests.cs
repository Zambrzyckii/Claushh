using Claushh.Api.Auth;
using Claushh.Api.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Claushh.Api.Tests;

public sealed class CleanupTests(ApiFactory api) : ApiTest(api)
{
    [Fact]
    public async Task Removes_attempts_and_sessions_that_ended_more_than_90_days_ago()
    {
        var loggedOut = new ApiClient(Api);
        await loggedOut.LoginAsOwnerAsync();
        await loggedOut.Http.PostAsync("/api/auth/logout", null);
        // This session is never ended; it only expires.
        await new ApiClient(Api).LoginAsOwnerAsync();
        await Client.LoginAsync("nobody", "wrong password", "000000");
        Api.Clock.Advance(TimeSpan.FromDays(90) + TimeSpan.FromHours(1));
        var current = await Client.LoginAsOwnerAsync();

        await CleanupAsync();

        await using var scope = Api.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ClaushhDbContext>();
        Assert.Equal(current.SessionId, Assert.Single(await db.Sessions.Select(s => s.Id).ToListAsync()));
        Assert.Equal(1, await db.LoginAttempts.CountAsync());
    }

    [Fact]
    public async Task Keeps_what_ended_less_than_90_days_ago()
    {
        await Client.LoginAsOwnerAsync();
        await Client.Http.PostAsync("/api/auth/logout", null);
        Api.Clock.Advance(TimeSpan.FromDays(89));

        await CleanupAsync();

        await using var scope = Api.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ClaushhDbContext>();
        Assert.Equal(1, await db.Sessions.CountAsync());
        Assert.Equal(1, await db.LoginAttempts.CountAsync());
    }

    private Task CleanupAsync() => Api.Services.GetRequiredService<AuthCleanup>().RunOnceAsync(CancellationToken.None);
}

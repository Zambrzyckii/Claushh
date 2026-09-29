using System.Net;

namespace Claushh.Api.Tests;

public sealed class LockoutTests(ApiFactory api) : ApiTest(api)
{
    [Fact]
    public async Task Five_wrong_codes_lock_login_for_15_minutes_whatever_the_credentials()
    {
        for (var i = 0; i < 5; i++)
        {
            Assert.Equal(HttpStatusCode.Unauthorized, (await LoginWithCodeAsync(Api.WrongTotp())).StatusCode);
        }

        var locked = await LoginWithCodeAsync(Api.CurrentTotp());
        var stranger = await Client.LoginAsync("nobody", "wrong password", "000000");

        Assert.Equal(HttpStatusCode.TooManyRequests, locked.StatusCode);
        Assert.Equal(TimeSpan.FromMinutes(15), locked.Headers.RetryAfter?.Delta);
        Assert.Equal(HttpStatusCode.TooManyRequests, stranger.StatusCode);
        Assert.Equal(5, await Api.LoginAttemptCountAsync());
    }

    [Fact]
    public async Task Login_works_again_exactly_when_the_lockout_ends()
    {
        for (var i = 0; i < 5; i++)
        {
            await LoginWithCodeAsync(Api.WrongTotp());
        }
        Api.Clock.Advance(TimeSpan.FromMinutes(15) - TimeSpan.FromSeconds(1));

        var early = await LoginWithCodeAsync(Api.CurrentTotp());
        Assert.Equal(HttpStatusCode.TooManyRequests, early.StatusCode);
        Assert.Equal(TimeSpan.FromSeconds(1), early.Headers.RetryAfter?.Delta);

        Api.Clock.Advance(TimeSpan.FromSeconds(1));

        Assert.Equal(HttpStatusCode.NoContent, (await LoginWithCodeAsync(Api.CurrentTotp())).StatusCode);
    }

    [Fact]
    public async Task Wrong_passwords_do_not_lock_the_account()
    {
        for (var i = 0; i < 9; i++)
        {
            await Client.LoginAsync(ApiFactory.UserName, "wrong password", Api.CurrentTotp());
        }

        Assert.Equal(HttpStatusCode.NoContent, (await LoginWithCodeAsync(Api.NextTotp())).StatusCode);
    }

    [Fact]
    public async Task A_successful_login_resets_the_counter()
    {
        for (var i = 0; i < 4; i++)
        {
            await LoginWithCodeAsync(Api.WrongTotp());
        }
        Assert.Equal(HttpStatusCode.NoContent, (await LoginWithCodeAsync(Api.NextTotp())).StatusCode);
        for (var i = 0; i < 4; i++)
        {
            await LoginWithCodeAsync(Api.WrongTotp());
        }

        Assert.Equal(HttpStatusCode.NoContent, (await LoginWithCodeAsync(Api.NextTotp())).StatusCode);
    }

    [Fact]
    public async Task A_reused_code_counts_as_a_wrong_code()
    {
        var code = Api.NextTotp();
        Assert.Equal(HttpStatusCode.NoContent, (await LoginWithCodeAsync(code)).StatusCode);
        for (var i = 0; i < 5; i++)
        {
            await LoginWithCodeAsync(code);
        }

        Assert.Equal(HttpStatusCode.TooManyRequests, (await LoginWithCodeAsync(Api.NextTotp())).StatusCode);
    }

    [Fact]
    public async Task A_second_lockout_without_a_successful_login_lasts_twice_as_long()
    {
        await LockAccountAsync();
        Api.Clock.Advance(TimeSpan.FromMinutes(15));
        await LockAccountAsync();

        var locked = await LoginWithCodeAsync(Api.CurrentTotp());

        Assert.Equal(HttpStatusCode.TooManyRequests, locked.StatusCode);
        Assert.Equal(TimeSpan.FromMinutes(30), locked.Headers.RetryAfter?.Delta);
    }

    [Fact]
    public async Task A_successful_login_resets_the_growth()
    {
        await LockAccountAsync();
        Api.Clock.Advance(TimeSpan.FromMinutes(15));
        await LockAccountAsync();
        Api.Clock.Advance(TimeSpan.FromMinutes(30));
        Assert.Equal(HttpStatusCode.NoContent, (await LoginWithCodeAsync(Api.NextTotp())).StatusCode);
        await LockAccountAsync();

        var locked = await LoginWithCodeAsync(Api.CurrentTotp());

        Assert.Equal(TimeSpan.FromMinutes(15), locked.Headers.RetryAfter?.Delta);
    }

    [Fact]
    public async Task Lockouts_stop_growing_at_24_hours()
    {
        foreach (var minutes in new[] { 15, 30, 60, 120, 240, 480, 960, 1440, 1440 })
        {
            await LockAccountAsync();
            var locked = await LoginWithCodeAsync(Api.CurrentTotp());
            Assert.Equal(TimeSpan.FromMinutes(minutes), locked.Headers.RetryAfter?.Delta);
            Api.Clock.Advance(TimeSpan.FromMinutes(minutes));
        }
    }

    [Fact]
    public async Task Retry_after_is_the_later_end_of_both_limits()
    {
        for (var i = 0; i < 5; i++)
        {
            await Client.LoginAsync(ApiFactory.UserName, "wrong password", Api.CurrentTotp());
        }
        Api.Clock.Advance(TimeSpan.FromMinutes(5));
        await LockAccountAsync();

        var refused = await LoginWithCodeAsync(Api.CurrentTotp());

        // The per-IP limit ends in 10 minutes (its 10th most recent failure is 5 minutes old), the lockout in 15.
        Assert.Equal(HttpStatusCode.TooManyRequests, refused.StatusCode);
        Assert.Equal(TimeSpan.FromMinutes(15), refused.Headers.RetryAfter?.Delta);
    }

    [Fact]
    public async Task After_a_lockout_ends_one_wrong_code_does_not_lock_again()
    {
        await LockAccountAsync();
        Api.Clock.Advance(TimeSpan.FromMinutes(15));

        Assert.Equal(HttpStatusCode.Unauthorized, (await LoginWithCodeAsync(Api.WrongTotp())).StatusCode);

        Assert.Equal(HttpStatusCode.NoContent, (await LoginWithCodeAsync(Api.NextTotp())).StatusCode);
    }

    [Fact]
    public async Task Parallel_wrong_codes_from_logged_in_browsers_lock_without_errors()
    {
        var clients = new List<ApiClient>();
        for (var i = 0; i < 8; i++)
        {
            var client = new ApiClient(Api);
            await client.LoginAsOwnerAsync();
            clients.Add(client);
        }

        var responses = await Task.WhenAll(clients.Select(client =>
            client.LoginAsync(ApiFactory.UserName, ApiFactory.Password, Api.WrongTotp())));

        var statuses = responses.Select(r => r.StatusCode).ToList();
        Assert.DoesNotContain(HttpStatusCode.InternalServerError, statuses);
        Assert.Equal(5, statuses.Count(s => s == HttpStatusCode.Unauthorized));
        Assert.Equal(3, statuses.Count(s => s == HttpStatusCode.TooManyRequests));
    }

    private Task<HttpResponseMessage> LoginWithCodeAsync(string code) =>
        Client.LoginAsync(ApiFactory.UserName, ApiFactory.Password, code);
}

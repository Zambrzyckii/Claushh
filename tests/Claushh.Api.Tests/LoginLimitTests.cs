using System.Net;

namespace Claushh.Api.Tests;

public sealed class LoginLimitTests(ApiFactory api) : ApiTest(api)
{
    [Fact]
    public async Task Ten_failures_from_one_ip_give_429_that_is_not_recorded()
    {
        await FailAsync(Client, 10);

        var response = await Client.LoginAsync(ApiFactory.UserName, ApiFactory.Password, Api.CurrentTotp());

        Assert.Equal(HttpStatusCode.TooManyRequests, response.StatusCode);
        Assert.Equal(TimeSpan.FromMinutes(15), response.Headers.RetryAfter?.Delta);
        Assert.Equal("", await response.Content.ReadAsStringAsync());
        Assert.Equal(10, await Api.LoginAttemptCountAsync());
    }

    [Fact]
    public async Task The_limit_ends_when_the_tenth_most_recent_failure_leaves_the_window()
    {
        await FailAsync(Client, 5);
        Api.Clock.Advance(TimeSpan.FromMinutes(5));
        await FailAsync(Client, 5);
        Api.Clock.Advance(TimeSpan.FromMinutes(10) - TimeSpan.FromSeconds(1));

        var early = await Client.LoginAsync(ApiFactory.UserName, ApiFactory.Password, Api.CurrentTotp());
        Assert.Equal(HttpStatusCode.TooManyRequests, early.StatusCode);
        Assert.Equal(TimeSpan.FromSeconds(1), early.Headers.RetryAfter?.Delta);

        Api.Clock.Advance(TimeSpan.FromSeconds(1));

        var response = await Client.LoginAsync(ApiFactory.UserName, ApiFactory.Password, Api.CurrentTotp());
        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
    }

    [Fact]
    public async Task Another_ip_is_not_limited()
    {
        await FailAsync(Client, 10);
        var other = new ApiClient(Api) { Ip = "198.51.100.7" };

        var response = await other.LoginAsync(ApiFactory.UserName, ApiFactory.Password, Api.NextTotp());

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
    }

    [Fact]
    public async Task Successful_logins_do_not_count()
    {
        for (var i = 0; i < 5; i++)
        {
            await Client.LoginAsOwnerAsync();
        }
        await FailAsync(Client, 9);

        var response = await Client.LoginAsync(ApiFactory.UserName, ApiFactory.Password, Api.NextTotp());

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
    }

    [Fact]
    public async Task Parallel_logins_with_the_same_code_let_only_one_in()
    {
        var code = Api.NextTotp();
        var clients = Enumerable.Range(0, 8).Select(_ => new ApiClient(Api)).ToList();

        var responses = await Task.WhenAll(clients.Select(client =>
            client.LoginAsync(ApiFactory.UserName, ApiFactory.Password, code)));

        var statuses = responses.Select(r => r.StatusCode).ToList();
        Assert.DoesNotContain(HttpStatusCode.InternalServerError, statuses);
        Assert.Single(statuses, s => s == HttpStatusCode.NoContent);
        Assert.Equal(5, statuses.Count(s => s == HttpStatusCode.Unauthorized));
        Assert.Equal(2, statuses.Count(s => s == HttpStatusCode.TooManyRequests));
        Assert.Equal(6, await Api.LoginAttemptCountAsync());
    }

    [Fact]
    public async Task A_long_user_agent_with_an_emoji_is_recorded_and_counted()
    {
        var client = new ApiClient(Api);
        client.Http.DefaultRequestHeaders.TryAddWithoutValidation("User-Agent", new string('a', 255) + "😀");

        for (var i = 0; i < 5; i++)
        {
            Assert.Equal(HttpStatusCode.Unauthorized,
                (await client.LoginAsync(ApiFactory.UserName, ApiFactory.Password, Api.WrongTotp())).StatusCode);
        }

        Assert.Equal(5, await Api.LoginAttemptCountAsync());
        Assert.Equal(HttpStatusCode.TooManyRequests,
            (await client.LoginAsync(ApiFactory.UserName, ApiFactory.Password, Api.WrongTotp())).StatusCode);
    }

    // Wrong passwords: they count for the IP limit, never for the account lockout.
    private static async Task FailAsync(ApiClient client, int times)
    {
        for (var i = 0; i < times; i++)
        {
            var response = await client.LoginAsync(ApiFactory.UserName, "wrong password", "000000");
            Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        }
    }
}

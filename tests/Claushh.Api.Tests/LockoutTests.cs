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

    private Task<HttpResponseMessage> LoginWithCodeAsync(string code) =>
        Client.LoginAsync(ApiFactory.UserName, ApiFactory.Password, code);
}

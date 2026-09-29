using System.Net;
using Claushh.Api.Auth;
using Microsoft.AspNetCore.Identity;
using Microsoft.Extensions.DependencyInjection;

namespace Claushh.Api.Tests;

public sealed class CreateUserTests(ApiFactory api) : ApiTest(api)
{
    private const string NewPassword = "a long enough password";

    [Fact]
    public async Task Creates_the_account_with_totp_after_a_correct_code()
    {
        await Api.ResetAsync(withUser: false);
        var terminal = new ScriptedTerminal(Api, _ => "boss", _ => NewPassword, _ => NewPassword, t => t.CurrentCode());

        Assert.Equal(0, await RunAsync(resetTotp: false, terminal));

        var login = await Client.LoginAsync("boss", NewPassword, terminal.NextCode());
        Assert.Equal(HttpStatusCode.NoContent, login.StatusCode);
        Assert.Contains(terminal.Output, line => line.StartsWith("URI: otpauth://totp/Claushh:boss?secret=", StringComparison.Ordinal));
    }

    [Fact]
    public async Task The_enrollment_code_does_not_log_in()
    {
        await Api.ResetAsync(withUser: false);
        var terminal = new ScriptedTerminal(Api, _ => "boss", _ => NewPassword, _ => NewPassword, t => t.CurrentCode());
        Assert.Equal(0, await RunAsync(resetTotp: false, terminal));

        var login = await Client.LoginAsync("boss", NewPassword, terminal.CurrentCode());

        Assert.Equal(HttpStatusCode.Unauthorized, login.StatusCode);
    }

    [Fact]
    public async Task Three_wrong_codes_leave_no_account()
    {
        await Api.ResetAsync(withUser: false);
        var terminal = new ScriptedTerminal(Api, _ => "boss", _ => NewPassword, _ => NewPassword,
            _ => "000000", _ => "000000", _ => "000000");

        Assert.Equal(1, await RunAsync(resetTotp: false, terminal));

        await using var scope = Api.Services.CreateAsyncScope();
        Assert.Empty(scope.ServiceProvider.GetRequiredService<UserManager<IdentityUser>>().Users);
    }

    [Fact]
    public async Task Different_passwords_create_nothing()
    {
        await Api.ResetAsync(withUser: false);
        var terminal = new ScriptedTerminal(Api, _ => "boss", _ => NewPassword, _ => "another long password");

        Assert.Equal(1, await RunAsync(resetTotp: false, terminal));
    }

    [Fact]
    public async Task A_second_account_is_refused()
    {
        var terminal = new ScriptedTerminal(Api, _ => "second");

        Assert.Equal(1, await RunAsync(resetTotp: false, terminal));
        Assert.Contains(terminal.Output, line => line.Contains("already exists", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Reset_totp_replaces_the_key_and_ends_all_sessions()
    {
        await Client.LoginAsOwnerAsync();
        var oldKey = Api.TotpKey;
        var terminal = new ScriptedTerminal(Api, t => t.NextCode());

        Assert.Equal(0, await RunAsync(resetTotp: true, terminal));

        Assert.NotEqual(oldKey, terminal.PrintedKey());
        Assert.Equal(HttpStatusCode.Unauthorized, (await Client.Http.GetAsync("/api/auth/me")).StatusCode);
        var fresh = new ApiClient(Api);
        Assert.Equal(HttpStatusCode.NoContent,
            (await fresh.LoginAsync(ApiFactory.UserName, ApiFactory.Password, terminal.NextCode())).StatusCode);
    }

    [Fact]
    public async Task Reset_totp_clears_the_lockout()
    {
        for (var i = 0; i < 5; i++)
        {
            await Client.LoginAsync(ApiFactory.UserName, ApiFactory.Password, Api.WrongTotp());
        }
        Assert.Equal(HttpStatusCode.TooManyRequests,
            (await Client.LoginAsync(ApiFactory.UserName, ApiFactory.Password, Api.NextTotp())).StatusCode);
        var terminal = new ScriptedTerminal(Api, t => t.NextCode());

        Assert.Equal(0, await RunAsync(resetTotp: true, terminal));

        Assert.Equal(HttpStatusCode.NoContent,
            (await Client.LoginAsync(ApiFactory.UserName, ApiFactory.Password, terminal.NextCode())).StatusCode);
    }

    [Fact]
    public async Task Reset_totp_also_clears_the_count_of_wrong_codes()
    {
        for (var i = 0; i < 4; i++)
        {
            await Client.LoginAsync(ApiFactory.UserName, ApiFactory.Password, Api.WrongTotp());
        }
        var terminal = new ScriptedTerminal(Api, t => t.NextCode());
        Assert.Equal(0, await RunAsync(resetTotp: true, terminal));

        await Client.LoginAsync(ApiFactory.UserName, ApiFactory.Password, Api.WrongTotp());

        Assert.Equal(HttpStatusCode.NoContent,
            (await Client.LoginAsync(ApiFactory.UserName, ApiFactory.Password, terminal.NextCode())).StatusCode);
    }

    [Fact]
    public async Task Reset_totp_also_resets_the_growth_of_lockouts()
    {
        await LockAccountAsync();
        Api.Clock.Advance(TimeSpan.FromMinutes(15));
        await LockAccountAsync();
        var terminal = new ScriptedTerminal(Api, t => t.NextCode());
        Assert.Equal(0, await RunAsync(resetTotp: true, terminal));
        Api.Clock.Advance(TimeSpan.FromMinutes(15));

        await LockAccountAsync();
        var locked = await Client.LoginAsync(ApiFactory.UserName, ApiFactory.Password, terminal.CurrentCode());

        Assert.Equal(TimeSpan.FromMinutes(15), locked.Headers.RetryAfter?.Delta);
    }

    [Fact]
    public async Task Reset_password_replaces_the_password_and_ends_all_sessions()
    {
        await Client.LoginAsOwnerAsync();
        var terminal = new ScriptedTerminal(Api, _ => NewPassword, _ => NewPassword);

        Assert.Equal(0, await ResetPasswordAsync(terminal));

        Assert.Equal(HttpStatusCode.Unauthorized, (await Client.Http.GetAsync("/api/auth/me")).StatusCode);
        var fresh = new ApiClient(Api);
        Assert.Equal(HttpStatusCode.Unauthorized,
            (await fresh.LoginAsync(ApiFactory.UserName, ApiFactory.Password, Api.NextTotp())).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent,
            (await fresh.LoginAsync(ApiFactory.UserName, NewPassword, Api.NextTotp())).StatusCode);
    }

    [Fact]
    public async Task Reset_password_clears_the_lockout()
    {
        await LockAccountAsync();
        var terminal = new ScriptedTerminal(Api, _ => NewPassword, _ => NewPassword);

        Assert.Equal(0, await ResetPasswordAsync(terminal));

        Assert.Equal(HttpStatusCode.NoContent,
            (await Client.LoginAsync(ApiFactory.UserName, NewPassword, Api.NextTotp())).StatusCode);
    }

    [Fact]
    public async Task A_too_short_new_password_changes_nothing()
    {
        await Client.LoginAsOwnerAsync();
        var terminal = new ScriptedTerminal(Api, _ => "too short", _ => "too short");

        Assert.Equal(1, await ResetPasswordAsync(terminal));

        Assert.Equal(HttpStatusCode.OK, (await Client.Http.GetAsync("/api/auth/me")).StatusCode);
        var fresh = new ApiClient(Api);
        Assert.Equal(HttpStatusCode.NoContent,
            (await fresh.LoginAsync(ApiFactory.UserName, ApiFactory.Password, Api.NextTotp())).StatusCode);
    }

    [Fact]
    public async Task Different_new_passwords_change_nothing()
    {
        var terminal = new ScriptedTerminal(Api, _ => NewPassword, _ => "another long password");

        Assert.Equal(1, await ResetPasswordAsync(terminal));

        Assert.Equal(HttpStatusCode.NoContent,
            (await Client.LoginAsync(ApiFactory.UserName, ApiFactory.Password, Api.NextTotp())).StatusCode);
    }

    [Fact]
    public async Task Reset_password_needs_an_account()
    {
        await Api.ResetAsync(withUser: false);
        var terminal = new ScriptedTerminal(Api);

        Assert.Equal(1, await ResetPasswordAsync(terminal));
        Assert.Contains(terminal.Output, line => line.Contains("no account", StringComparison.Ordinal));
    }

    private async Task<int> RunAsync(bool resetTotp, ITerminal terminal)
    {
        await using var scope = Api.Services.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<CreateUserCommand>()
            .RunAsync(resetTotp, terminal, CancellationToken.None);
    }

    private async Task<int> ResetPasswordAsync(ITerminal terminal)
    {
        await using var scope = Api.Services.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<CreateUserCommand>()
            .ResetPasswordAsync(terminal, CancellationToken.None);
    }
}

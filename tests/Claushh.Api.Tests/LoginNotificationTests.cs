using System.Globalization;
using System.Net;
using Microsoft.AspNetCore.Hosting;

namespace Claushh.Api.Tests;

// Phone notifications through ntfy (docs/ARCHITECTURE.md, "Backend" → "Notifications"), received by TestNtfy. Every login
// of the whole test run sends one, so each test uses its own addresses and looks only at the messages for them. The API
// sends one message at a time in order, so a later message for another address proves that none came before it.
public sealed class LoginNotificationTests(ApiFactory api) : ApiTest(api)
{
    private const string ChromeOnLinux =
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

    [Fact]
    public async Task A_login_sends_one_notification_with_the_address_and_device_and_no_user_name()
    {
        await Browser("192.0.2.41").LoginAsOwnerAsync();
        var time = Now();
        await Browser("192.0.2.49").LoginAsOwnerAsync();

        var sent = await Api.Ntfy.UntilAsync(m => m.Body.Contains("192.0.2.49", StringComparison.Ordinal));

        var login = Assert.Single(sent, m => m.Body.Contains("192.0.2.41", StringComparison.Ordinal));
        Assert.Equal(HttpMethod.Post, login.Method);
        Assert.Equal("https://ntfy.test/claushh-test", login.Url?.ToString());
        Assert.Equal("Bearer tk_test", login.Authorization);
        Assert.Equal("Claushh: logowanie", login.Title);
        Assert.Equal("default", login.Priority);
        Assert.Equal($"Zalogowano z 192.0.2.41 (Chrome · Linux), {time} UTC.", login.Body);
        Assert.DoesNotContain(ApiFactory.UserName, login.Body, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Only_the_start_of_a_lock_sends_a_notification_and_failed_attempts_send_none()
    {
        Client.Ip = "192.0.2.42";
        Client.Http.DefaultRequestHeaders.TryAddWithoutValidation("User-Agent", ChromeOnLinux);
        Assert.Equal(HttpStatusCode.Unauthorized,
            (await Client.LoginAsync(ApiFactory.UserName, "wrong password", Api.CurrentTotp())).StatusCode);
        await LockAccountAsync();
        var lockedAt = Now();
        Assert.Equal(HttpStatusCode.TooManyRequests,
            (await Client.LoginAsync(ApiFactory.UserName, ApiFactory.Password, Api.CurrentTotp())).StatusCode);
        Api.Clock.Advance(TimeSpan.FromMinutes(15));
        await Browser("192.0.2.43").LoginAsOwnerAsync();

        var sent = await Api.Ntfy.UntilAsync(m => m.Body.Contains("192.0.2.43", StringComparison.Ordinal));

        var locked = Assert.Single(sent, m => m.Body.Contains("192.0.2.42", StringComparison.Ordinal));
        Assert.Equal("Claushh: konto zablokowane", locked.Title);
        Assert.Equal("high", locked.Priority);
        Assert.Equal("Konto zablokowane na 15 min po 5 błędnych kodach przy poprawnym haśle; ostatnia próba z 192.0.2.42 "
            + $"(Chrome · Linux), {lockedAt} UTC. Jeśli to nie Ty: create-user --reset-password.", locked.Body);
    }

    [Theory]
    [InlineData(TestNtfy.Failure.Status500)]
    [InlineData(TestNtfy.Failure.Throw)]
    public async Task A_failing_ntfy_leaves_the_login_working_and_the_next_notification_goes_out(TestNtfy.Failure failure)
    {
        Api.Ntfy.FailWith = failure;

        Assert.Equal(HttpStatusCode.NoContent,
            (await Browser("192.0.2.44").LoginAsync(ApiFactory.UserName, ApiFactory.Password, Api.NextTotp())).StatusCode);
        await Api.Ntfy.UntilAsync(m => m.Body.Contains("192.0.2.44", StringComparison.Ordinal));
        Api.Ntfy.FailWith = TestNtfy.Failure.None;
        await Browser("192.0.2.45").LoginAsOwnerAsync();

        await Api.Ntfy.UntilAsync(m => m.Body.Contains("192.0.2.45", StringComparison.Ordinal));
    }

    [Theory]
    [InlineData("Production", "", "must be set in Production")]
    [InlineData("Testing", "http://ntfy.test/claushh-test", "absolute https URL")]
    public void The_api_refuses_to_start_without_a_usable_ntfy_url(string environment, string url, string reason)
    {
        using var broken = Api.WithWebHostBuilder(builder =>
        {
            builder.UseEnvironment(environment);
            builder.UseSetting("Notifications:NtfyUrl", url);
        });

        var error = Assert.ThrowsAny<Exception>(() => broken.CreateClient()).ToString();

        Assert.Contains("Notifications:NtfyUrl", error, StringComparison.Ordinal);
        Assert.Contains(reason, error, StringComparison.Ordinal);
    }

    private ApiClient Browser(string ip)
    {
        var browser = new ApiClient(Api) { Ip = ip };
        browser.Http.DefaultRequestHeaders.TryAddWithoutValidation("User-Agent", ChromeOnLinux);
        return browser;
    }

    // The API's time format in the notifications, from the test clock.
    private string Now() => Api.Clock.GetUtcNow().ToString("yyyy-MM-dd HH:mm", CultureInfo.InvariantCulture);
}

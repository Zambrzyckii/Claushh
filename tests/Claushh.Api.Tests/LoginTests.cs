using System.Net;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Identity;
using Microsoft.Extensions.DependencyInjection;

namespace Claushh.Api.Tests;

public sealed class LoginTests(ApiFactory api) : ApiTest(api)
{
    [Fact]
    public async Task Me_without_session_is_401_and_issues_an_xsrf_token()
    {
        var response = await Client.Http.GetAsync("/api/auth/me");

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        var cookie = ApiClient.SetCookie(response, "XSRF-TOKEN");
        Assert.Contains("secure", cookie);
        Assert.Contains("samesite=strict", cookie);
        Assert.Contains("path=/", cookie);
        Assert.DoesNotContain("httponly", cookie);
    }

    [Fact]
    public async Task Login_without_xsrf_header_is_400()
    {
        Client.SendXsrf = false;

        var response = await Client.LoginAsync(ApiFactory.UserName, ApiFactory.Password, Api.CurrentTotp());

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task Login_sets_a_browser_session_cookie_that_me_accepts()
    {
        var response = await Client.LoginAsync(ApiFactory.UserName, ApiFactory.Password, Api.CurrentTotp());

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        var cookie = ApiClient.SetCookie(response, ApiClient.SessionCookie);
        Assert.Contains("httponly", cookie);
        Assert.Contains("secure", cookie);
        Assert.Contains("samesite=strict", cookie);
        Assert.Contains("path=/", cookie);
        Assert.DoesNotContain("expires", cookie);
        Assert.DoesNotContain("max-age", cookie);

        var me = await Client.MeAsync();
        Assert.Equal(ApiFactory.UserName, me.UserName);
        Assert.NotEqual(Guid.Empty, me.SessionId);
        Assert.Equal(30 * 60, me.ExpiresIn);
        Assert.Equal(12 * 60 * 60, me.AbsoluteExpiresIn);
    }

    [Fact]
    public async Task Login_ignores_the_case_of_the_user_name()
    {
        var response = await Client.LoginAsync("OWNER", ApiFactory.Password, Api.CurrentTotp());

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
    }

    [Theory]
    [InlineData("owner", "wrong password", true)]
    [InlineData("owner", ApiFactory.Password, false)]
    [InlineData("nobody", ApiFactory.Password, true)]
    [InlineData("", ApiFactory.Password, true)]
    public async Task Wrong_login_details_all_give_the_same_empty_401(string userName, string password, bool validCode)
    {
        var code = validCode ? Api.CurrentTotp() : WrongCode();

        var response = await Client.LoginAsync(userName, password, code);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        Assert.Equal("", await response.Content.ReadAsStringAsync());
        Assert.Null(Client.Cookie(ApiClient.SessionCookie));
    }

    [Fact]
    public async Task Oversized_password_and_missing_fields_give_401()
    {
        await Client.Http.GetAsync("/api/auth/me");

        var oversized = await Client.Http.PostAsJsonAsync("/api/auth/login",
            new { userName = ApiFactory.UserName, password = new string('x', 1025), totpCode = Api.CurrentTotp() });
        var missing = await Client.Http.PostAsJsonAsync("/api/auth/login", new { userName = ApiFactory.UserName });

        Assert.Equal(HttpStatusCode.Unauthorized, oversized.StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, missing.StatusCode);
    }

    [Fact]
    public async Task Account_without_totp_enabled_cannot_log_in()
    {
        await using (var scope = Api.Services.CreateAsyncScope())
        {
            var users = scope.ServiceProvider.GetRequiredService<UserManager<IdentityUser>>();
            await users.SetTwoFactorEnabledAsync((await users.FindByNameAsync(ApiFactory.UserName))!, false);
        }

        var response = await Client.LoginAsync(ApiFactory.UserName, ApiFactory.Password, Api.CurrentTotp());

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Theory]
    [InlineData("not-a-valid-secret")]
    [InlineData("AAAA")]
    public async Task Garbage_session_cookie_means_no_session(string value)
    {
        Client.Cookies.Add(ApiClient.BaseAddress, new Cookie(ApiClient.SessionCookie, value, "/"));

        var response = await Client.Http.GetAsync("/api/auth/me");

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task Anonymous_xsrf_token_is_rejected_after_login()
    {
        var login = await Client.LoginAsync(ApiFactory.UserName, ApiFactory.Password, Api.CurrentTotp());
        Assert.Equal(HttpStatusCode.NoContent, login.StatusCode);

        // Still the token from before the login, issued for "no session".
        var again = await Client.Http.PostAsJsonAsync("/api/auth/login",
            new { userName = ApiFactory.UserName, password = ApiFactory.Password, totpCode = Api.CurrentTotp() });

        Assert.Equal(HttpStatusCode.BadRequest, again.StatusCode);
    }

    [Fact]
    public async Task Xsrf_token_of_one_session_is_rejected_in_the_next_session_of_the_same_user()
    {
        await Client.LoginAsOwnerAsync();
        var firstSessionToken = Client.Cookie("XSRF-TOKEN");
        // A second login in the same browser: the same user and the same antiforgery cookie, a new session.
        var second = await Client.Http.PostAsJsonAsync("/api/auth/login",
            new { userName = ApiFactory.UserName, password = ApiFactory.Password, totpCode = Api.CurrentTotp() });
        Assert.Equal(HttpStatusCode.NoContent, second.StatusCode);
        Assert.Equal(firstSessionToken, Client.Cookie("XSRF-TOKEN"));

        var third = await Client.Http.PostAsJsonAsync("/api/auth/login",
            new { userName = ApiFactory.UserName, password = ApiFactory.Password, totpCode = Api.CurrentTotp() });

        Assert.Equal(HttpStatusCode.BadRequest, third.StatusCode);
    }

    private string WrongCode() => Api.CurrentTotp() == "000000" ? "111111" : "000000";
}

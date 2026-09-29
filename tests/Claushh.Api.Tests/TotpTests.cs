using System.Net;

namespace Claushh.Api.Tests;

public sealed class TotpTests(ApiFactory api) : ApiTest(api)
{
    [Fact]
    public async Task The_same_code_logs_in_only_once()
    {
        var code = Api.NextTotp();
        Assert.Equal(HttpStatusCode.NoContent, (await Client.LoginAsync(ApiFactory.UserName, ApiFactory.Password, code)).StatusCode);

        var again = await new ApiClient(Api).LoginAsync(ApiFactory.UserName, ApiFactory.Password, code);

        Assert.Equal(HttpStatusCode.Unauthorized, again.StatusCode);
    }

    [Fact]
    public async Task An_older_code_is_rejected_after_a_newer_one()
    {
        var newer = Api.NextTotp();
        var older = Api.TotpAt(TimeSpan.FromSeconds(-30));
        Assert.Equal(HttpStatusCode.NoContent, (await Client.LoginAsync(ApiFactory.UserName, ApiFactory.Password, newer)).StatusCode);

        var response = await new ApiClient(Api).LoginAsync(ApiFactory.UserName, ApiFactory.Password, older);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Theory]
    [InlineData(-30, HttpStatusCode.NoContent)]
    [InlineData(0, HttpStatusCode.NoContent)]
    [InlineData(30, HttpStatusCode.NoContent)]
    [InlineData(-60, HttpStatusCode.Unauthorized)]
    [InlineData(60, HttpStatusCode.Unauthorized)]
    public async Task Codes_are_accepted_one_step_around_now(int offsetSeconds, HttpStatusCode expected)
    {
        var code = Api.TotpAt(TimeSpan.FromSeconds(offsetSeconds));

        var response = await Client.LoginAsync(ApiFactory.UserName, ApiFactory.Password, code);

        Assert.Equal(expected, response.StatusCode);
    }

    [Theory]
    [InlineData("12345a")]
    [InlineData("１２３４５６")]
    [InlineData("12 456")]
    public async Task A_code_that_is_not_six_ascii_digits_is_401(string code)
    {
        var response = await Client.LoginAsync(ApiFactory.UserName, ApiFactory.Password, code);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }
}

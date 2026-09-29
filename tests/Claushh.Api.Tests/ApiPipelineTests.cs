using System.Net;

namespace Claushh.Api.Tests;

public sealed class ApiPipelineTests(ApiFactory api) : ApiTest(api)
{
    [Fact]
    public async Task Every_api_response_is_no_store()
    {
        var health = await Client.Http.GetAsync("/api/health");
        var anonymousMe = await Client.Http.GetAsync("/api/auth/me");
        var login = await Client.LoginAsync(ApiFactory.UserName, ApiFactory.Password, Api.NextTotp());
        var unknown = await Client.Http.GetAsync("/api/does-not-exist");

        foreach (var response in new[] { health, anonymousMe, login, unknown })
        {
            Assert.True(response.Headers.CacheControl?.NoStore, $"{response.RequestMessage!.RequestUri} without no-store");
        }
    }

    [Fact]
    public async Task Unknown_api_path_is_401_without_a_session_and_404_with_one()
    {
        Assert.Equal(HttpStatusCode.Unauthorized, (await Client.Http.GetAsync("/api/files/tree")).StatusCode);

        await Client.LoginAsOwnerAsync();

        Assert.Equal(HttpStatusCode.NotFound, (await Client.Http.GetAsync("/api/files/tree")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await Client.Http.PostAsync("/api/files/tree", null)).StatusCode);
    }
}

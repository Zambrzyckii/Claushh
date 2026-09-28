using System.Net;

namespace Claushh.Api.Tests;

public sealed class HealthTests(ApiFactory api)
{
    [Fact]
    public async Task Health_is_public()
    {
        var response = await api.CreateClient().GetAsync("/api/health");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }
}

using System.Net;

namespace Claushh.Api.Tests;

// Every test starts from an empty database with the seeded owner and a fresh browser.
public abstract class ApiTest(ApiFactory api) : IAsyncLifetime
{
    protected ApiFactory Api { get; } = api;
    protected ApiClient Client { get; } = new(api);

    public virtual async ValueTask InitializeAsync() => await Api.ResetAsync();

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    // Five wrong codes after the correct password: locks the account (docs/ARCHITECTURE.md, "Login protection").
    protected async Task LockAccountAsync()
    {
        for (var i = 0; i < 5; i++)
        {
            Assert.Equal(HttpStatusCode.Unauthorized,
                (await Client.LoginAsync(ApiFactory.UserName, ApiFactory.Password, Api.WrongTotp())).StatusCode);
        }
    }
}

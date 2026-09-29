namespace Claushh.Api.Tests;

// Every test starts from an empty database with the seeded owner and a fresh browser.
public abstract class ApiTest(ApiFactory api) : IAsyncLifetime
{
    protected ApiFactory Api { get; } = api;
    protected ApiClient Client { get; } = new(api);

    public virtual async ValueTask InitializeAsync() => await Api.ResetAsync();

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;
}

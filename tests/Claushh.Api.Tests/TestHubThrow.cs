// Lets a hub-connection test make the connect pipeline fail after HubSessionFilter's own checks have passed, so a
// test can assert that HubConnections does not leak the entry when OnConnectedAsync throws
// (docs/ARCHITECTURE.md, "Backend" → "Hubs"). Inert unless the connect request carries QueryParam. Registered only by
// ApiFactory, never in the API.
using Microsoft.AspNetCore.SignalR;

namespace Claushh.Api.Tests;

public sealed class TestHubThrow : IHubFilter
{
    public const string QueryParam = "throwOnConnect";

    public Task OnConnectedAsync(HubLifetimeContext context, Func<HubLifetimeContext, Task> next) =>
        context.Context.GetHttpContext()?.Request.Query.ContainsKey(QueryParam) == true
            ? throw new InvalidOperationException("Test-only failure inside OnConnectedAsync.")
            : next(context);
}

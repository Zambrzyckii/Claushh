// Sets the connection's IP from a test header: TestServer leaves RemoteIpAddress empty, and the per-IP login limit needs
// different addresses. Registered only by ApiFactory, never in the API.
using System.Net;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;

namespace Claushh.Api.Tests;

public sealed class TestRemoteIp : IStartupFilter
{
    public const string Header = "X-Test-Remote-Ip";

    public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next) => app =>
    {
        app.Use((context, nextMiddleware) =>
        {
            var ip = context.Request.Headers[Header].ToString();
            if (ip.Length > 0)
            {
                context.Connection.RemoteIpAddress = IPAddress.Parse(ip);
            }
            return nextMiddleware(context);
        });
        next(app);
    };
}

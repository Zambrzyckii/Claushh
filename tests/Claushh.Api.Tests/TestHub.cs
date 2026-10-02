// SignalR connections to the API in memory (docs/ARCHITECTURE.md, "Tests"): WebSocket only and without negotiation, as
// the frontend connects (web/src/app/core/realtime/hub-client.ts), with the browser's cookies and Origin header.
using Microsoft.AspNetCore.Http.Connections;
using Microsoft.AspNetCore.SignalR.Client;

namespace Claushh.Api.Tests;

public static class TestHub
{
    // The origin of ApiClient.BaseAddress, and the one entry of Hubs:AllowedOrigins in the tests.
    public const string Origin = "https://localhost";

    // Not started yet, so a test can register handlers first. origin null: no Origin header at all.
    public static HubConnection Build(ApiFactory api, ApiClient client, string path = "/hubs/terminal", string? origin = Origin) =>
        new HubConnectionBuilder()
            .WithUrl(new Uri(ApiClient.BaseAddress, path), options =>
            {
                options.Transports = HttpTransportType.WebSockets;
                options.SkipNegotiation = true;
                // TestServer's own WebSocket client; it sends neither cookies nor Origin unless told to.
                options.WebSocketFactory = async (context, ct) =>
                {
                    var socket = api.Server.CreateWebSocketClient();
                    socket.ConfigureRequest = request =>
                    {
                        if (origin is not null)
                        {
                            request.Headers.Origin = origin;
                        }
                        var cookies = client.Cookies.GetCookieHeader(ApiClient.BaseAddress);
                        if (cookies.Length > 0)
                        {
                            request.Headers.Cookie = cookies;
                        }
                    };
                    return await socket.ConnectAsync(context.Uri, ct);
                };
            })
            .Build();

    public static async Task<HubConnection> ConnectAsync(ApiFactory api, ApiClient client, string path = "/hubs/terminal")
    {
        var connection = Build(api, client, path);
        await connection.StartAsync();
        return connection;
    }

    // Completes when the server closes the connection.
    public static Task WhenClosed(HubConnection connection)
    {
        var closed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        connection.Closed += _ =>
        {
            closed.TrySetResult();
            return Task.CompletedTask;
        };
        return closed.Task;
    }
}

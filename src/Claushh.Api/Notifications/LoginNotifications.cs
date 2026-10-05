// Phone notifications through ntfy (docs/ARCHITECTURE.md, "Backend" → "Notifications"; decisions: docs/PLAN.md, "Backend
// decisions (stage 1, part C)"): every successful login, every start of an account lock, and every passkey added or
// removed. A request only queues a message; this background service sends them one at a time, once each, outside the
// login gate, and only logs a failure, so ntfy never holds up or fails a request. The topic URL is a secret and is never
// logged.
using System.Globalization;
using System.Net.Http.Headers;
using System.Text;
using System.Threading.Channels;
using Claushh.Api.Auth;
using Microsoft.Extensions.Options;

namespace Claushh.Api.Notifications;

public sealed class LoginNotifications(IHttpClientFactory clients, IOptions<NotificationsOptions> options, TimeProvider clock,
    ILogger<LoginNotifications> log) : BackgroundService
{
    public const string ClientName = "ntfy";
    public static readonly TimeSpan SendTimeout = TimeSpan.FromSeconds(10);
    private const int QueueLength = 100;

    private readonly Channel<Message> _queue =
        Channel.CreateBounded<Message>(new BoundedChannelOptions(QueueLength) { SingleReader = true });

    public void LoggedIn(string ip, string userAgent) =>
        Enqueue("Claushh: logowanie", "default", $"Zalogowano z {ip} ({Device(userAgent)}), {Now()} UTC.");

    // lockout: the length of the lock that has just started.
    public void AccountLocked(TimeSpan lockout, string ip, string userAgent) =>
        Enqueue("Claushh: konto zablokowane", "high", string.Create(CultureInfo.InvariantCulture,
            $"Konto zablokowane na {(int)lockout.TotalMinutes} min po 5 błędnych kodach przy poprawnym haśle; ostatnia próba z {ip} ({Device(userAgent)}), {Now()} UTC. Jeśli to nie Ty: create-user --reset-password."));

    public void PasskeyAdded(string name, string ip, string userAgent) =>
        Enqueue("Claushh: passkey added", "high",
            $"Passkey \"{name}\" added from {ip} ({Device(userAgent)}), {Now()} UTC. If this was not you: create-user --reset-password.");

    public void PasskeyRemoved(string name, string ip, string userAgent) =>
        Enqueue("Claushh: passkey removed", "high",
            $"Passkey \"{name}\" removed from {ip} ({Device(userAgent)}), {Now()} UTC. If this was not you: create-user --reset-password.");

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (options.Value.NtfyUrl.Length == 0)
        {
            log.LogInformation("Login notifications are off: Notifications:NtfyUrl is not set");
            return;
        }
        await foreach (var message in _queue.Reader.ReadAllAsync(stoppingToken))
        {
            await SendAsync(message, stoppingToken);
        }
    }

    private void Enqueue(string title, string priority, string body)
    {
        if (options.Value.NtfyUrl.Length > 0 && !_queue.Writer.TryWrite(new Message(title, priority, body)))
        {
            log.LogWarning("A login notification was dropped: {Count} are waiting already", QueueLength);
        }
    }

    private async Task SendAsync(Message message, CancellationToken ct)
    {
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, options.Value.NtfyUrl)
            {
                Content = new StringContent(message.Body, Encoding.UTF8, "text/plain"),
            };
            // ASCII titles: header values are not UTF-8 on the wire. The body carries the text (Polish; English for passkeys).
            request.Headers.TryAddWithoutValidation("Title", message.Title);
            request.Headers.TryAddWithoutValidation("Priority", message.Priority);
            if (options.Value.NtfyToken.Length > 0)
            {
                request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", options.Value.NtfyToken);
            }
            using var response = await clients.CreateClient(ClientName).SendAsync(request, ct);
            if (!response.IsSuccessStatusCode)
            {
                log.LogWarning("ntfy refused a login notification with {Status}", (int)response.StatusCode);
            }
        }
        catch (Exception e) when (!ct.IsCancellationRequested)
        {
            // Only the type: an HttpRequestException's message can contain the URL, whose path is the secret topic.
            log.LogWarning("A login notification could not be sent: {Error}", e.GetType().Name);
        }
    }

    private string Now() => clock.GetUtcNow().ToString("yyyy-MM-dd HH:mm", CultureInfo.InvariantCulture);

    private static string Device(string userAgent) => DeviceName.From(DeviceName.Stored(userAgent));

    private sealed record Message(string Title, string Priority, string Body);
}

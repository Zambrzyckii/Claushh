// Stands in for ntfy.sh at the network boundary: the primary handler of the API's "ntfy" HttpClient (ApiFactory). It keeps
// every request in arrival order and can answer 500 or throw instead of 200. A plain HttpMessageHandler without dispose
// state, so the client factory's handler rotation can reuse it.
using System.Net;
using System.Threading.Channels;

namespace Claushh.Api.Tests;

public sealed class TestNtfy : HttpMessageHandler
{
    private readonly Channel<Sent> _sent = Channel.CreateUnbounded<Sent>();

    public enum Failure { None, Status500, Throw }

    public sealed record Sent(HttpMethod Method, Uri? Url, string? Authorization, string? Title, string? Priority, string Body);

    public Failure FailWith { get; set; }

    // The requests that arrive until one matches last (included), at most 10 s.
    public async Task<List<Sent>> UntilAsync(Func<Sent, bool> last)
    {
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var sent = new List<Sent>();
        while (true)
        {
            var next = await _sent.Reader.ReadAsync(deadline.Token);
            sent.Add(next);
            if (last(next))
            {
                return sent;
            }
        }
    }

    public void Reset()
    {
        FailWith = Failure.None;
        while (_sent.Reader.TryRead(out _))
        {
        }
    }

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        // Decided on arrival, so a test may switch it back as soon as it sees this request.
        var failure = FailWith;
        var body = await request.Content!.ReadAsStringAsync(ct);
        _sent.Writer.TryWrite(new Sent(request.Method, request.RequestUri, request.Headers.Authorization?.ToString(),
            Header(request, "Title"), Header(request, "Priority"), body));
        return failure switch
        {
            Failure.Throw => throw new HttpRequestException("ntfy is unreachable"),
            Failure.Status500 => new HttpResponseMessage(HttpStatusCode.InternalServerError),
            _ => new HttpResponseMessage(HttpStatusCode.OK),
        };
    }

    private static string? Header(HttpRequestMessage request, string name) =>
        request.Headers.TryGetValues(name, out var values) ? string.Join(",", values) : null;
}

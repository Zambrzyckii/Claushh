// Captures what the API logs while a test listens (docs/ARCHITECTURE.md, "Tests"): SearchTests checks that a search query
// never reaches a log. A provider of the test host's logging (ApiFactory); off unless a test listens, so the other tests
// do not format every message.
using System.Collections.Concurrent;
using Microsoft.Extensions.Logging;

namespace Claushh.Api.Tests;

public sealed class TestLogs : ILoggerProvider
{
    private readonly ConcurrentQueue<string> _entries = new();
    private volatile bool _listening;

    // Everything logged since Listen, one entry each: category, level, message, structured values and exception.
    public IReadOnlyList<string> Entries => [.. _entries];

    public void Listen()
    {
        _entries.Clear();
        _listening = true;
    }

    // Before every test (ApiFactory.ResetAsync).
    public void Reset()
    {
        _listening = false;
        _entries.Clear();
    }

    public ILogger CreateLogger(string categoryName) => new Logger(this, categoryName);

    public void Dispose()
    {
    }

    private sealed class Logger(TestLogs logs, string category) : ILogger
    {
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => logs._listening;

        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception,
            Func<TState, Exception?, string> formatter)
        {
            if (!logs._listening)
            {
                return;
            }
            var values = state is IEnumerable<KeyValuePair<string, object?>> pairs
                ? string.Join(" ", pairs.Select(pair => $"{pair.Key}={pair.Value}"))
                : "";
            logs._entries.Enqueue($"{category} {logLevel}: {formatter(state, exception)} {values} {exception}");
        }
    }
}

using Claushh.Api.Auth;

namespace Claushh.Api.Tests;

// Answers the command's questions in order. An answer is computed when asked, so it can use what was printed before
// (the TOTP key).
public sealed class ScriptedTerminal(params Func<ScriptedTerminal, string?>[] answers) : ITerminal
{
    private readonly Queue<Func<ScriptedTerminal, string?>> _answers = new(answers);

    public List<string> Output { get; } = [];

    public string? ReadLine() => _answers.Count > 0 ? _answers.Dequeue()(this) : null;

    public string? ReadSecret() => ReadLine();

    public void WriteLine(string text) => Output.Add(text);

    public string PrintedKey() =>
        Output.Single(line => line.StartsWith("TOTP key: ", StringComparison.Ordinal))["TOTP key: ".Length..].Replace(" ", "");

    public string CurrentCode() => Totp.Code(PrintedKey(), DateTimeOffset.UtcNow);
}

// The frontend's clone URL rule (web/src/app/features/workspaces/validation.ts) in .NET terms: the CLONE_URL pattern,
// then what `new URL(url).href === url` checks for a string that passed it, and the directory name
// (docs/ARCHITECTURE.md, "Workspaces and git"; decisions: docs/PLAN.md, "Backend decisions (stage 4)").
using System.Diagnostics.CodeAnalysis;
using System.Globalization;
using System.Text.RegularExpressions;

namespace Claushh.Api.Workspaces;

public static partial class CloneUrl
{
    public static bool IsValid([NotNullWhen(true)] string? url)
    {
        if (url is null || Pattern().Match(url) is not { Success: true } match)
        {
            return false;
        }
        var port = match.Groups["port"].Value;
        return match.Groups["path"].Value.Split('/').All(segment => segment is not ("." or ".."))
            && (port.Length == 0 || IsCanonicalPort(port))
            && IsCanonicalHost(match.Groups["host"].Value);
    }

    // The last path segment without a final ".git", or null when that is not a safe directory name.
    public static string? DirectoryName(string url)
    {
        var trimmed = url.TrimEnd('/');
        var last = trimmed[(trimmed.LastIndexOf('/') + 1)..];
        var name = last.EndsWith(".git", StringComparison.Ordinal) ? last[..^4] : last;
        return DirectoryNamePattern().IsMatch(name) ? name : null;
    }

    // WHATWG drops the default port 443 and leading zeros.
    private static bool IsCanonicalPort(string port) =>
        (port.Length == 1 || port[0] != '0') && int.Parse(port, CultureInfo.InvariantCulture) is <= 65535 and not 443;

    // A host whose last label is a number is an IPv4 address to WHATWG, which rewrites every form of it but the plain
    // dotted quad. "xn--" labels are refused instead of being checked as punycode.
    private static bool IsCanonicalHost(string host)
    {
        var labels = host.Split('.');
        if (labels.Any(label => label.StartsWith("xn--", StringComparison.Ordinal)))
        {
            return false;
        }
        var last = labels.Length > 1 && labels[^1].Length == 0 ? labels[^2] : labels[^1];
        var endsInNumber = (last.Length > 0 && last.All(char.IsAsciiDigit)) || last.StartsWith("0x", StringComparison.Ordinal);
        return !endsInNumber || (labels.Length == 4 && labels.All(IsIpv4Part));
    }

    private static bool IsIpv4Part(string label) =>
        label.Length is > 0 and <= 3 && label.All(char.IsAsciiDigit) && (label.Length == 1 || label[0] != '0')
        && int.Parse(label, CultureInfo.InvariantCulture) <= 255;

    // [0-9] and \z: .NET's \d also matches other digits, and its $ also matches before a final newline.
    [GeneratedRegex(@"^https://(?<host>[a-z0-9.-]+)(?::(?<port>[0-9]{1,5}))?(?<path>(?:/[A-Za-z0-9._~-]+)+)/?\z")]
    private static partial Regex Pattern();

    [GeneratedRegex(@"^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}\z")]
    private static partial Regex DirectoryNamePattern();
}

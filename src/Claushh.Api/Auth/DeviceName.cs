// The User-Agent as it is stored with sessions and login attempts, and as the security window shows it, e.g.
// "Chrome · Linux" (docs/ARCHITECTURE.md, "Backend"). The rules match the mock (web/e2e/mock-api/server.mjs,
// deviceOf); the fallbacks are English like the rest of the interface.
namespace Claushh.Api.Auth;

public static class DeviceName
{
    private const int MaxStoredLength = 256;

    // At most 256 UTF-16 units, never ending between the two halves of a surrogate pair (e.g. an emoji): a lone half
    // cannot be stored.
    public static string Stored(string userAgent)
    {
        if (userAgent.Length <= MaxStoredLength)
        {
            return userAgent;
        }
        var length = char.IsHighSurrogate(userAgent[MaxStoredLength - 1]) ? MaxStoredLength - 1 : MaxStoredLength;
        return userAgent[..length];
    }

    public static string From(string userAgent)
    {
        var browser = userAgent.Contains("Firefox/", StringComparison.Ordinal) ? "Firefox"
            : userAgent.Contains("Edg/", StringComparison.Ordinal) ? "Edge"
            : userAgent.Contains("Chrom", StringComparison.Ordinal) ? "Chrome"
            : userAgent.Contains("Safari/", StringComparison.Ordinal) ? "Safari"
            : "Browser";
        var system = userAgent.Contains("Windows", StringComparison.Ordinal) ? "Windows"
            : userAgent.Contains("Android", StringComparison.Ordinal) ? "Android"
            : userAgent.Contains("iPhone", StringComparison.Ordinal) || userAgent.Contains("iPad", StringComparison.Ordinal) ? "iOS"
            : userAgent.Contains("Mac OS", StringComparison.Ordinal) ? "macOS"
            : userAgent.Contains("Linux", StringComparison.Ordinal) ? "Linux"
            : "unknown system";
        return $"{browser} · {system}";
    }
}

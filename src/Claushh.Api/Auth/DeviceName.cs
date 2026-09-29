// The User-Agent as it is stored with sessions and login attempts, and as it is shown in the "Bezpieczeństwo" window,
// e.g. "Chrome · Linux" (docs/ARCHITECTURE.md, "Backend"). The rules match the mock (web/e2e/mock-api/server.mjs,
// deviceOf); the fallbacks are Polish like the rest of the interface.
namespace Claushh.Api.Auth;

public static class DeviceName
{
    private const int MaxStoredLength = 256;

    public static string Stored(string userAgent) =>
        userAgent.Length > MaxStoredLength ? userAgent[..MaxStoredLength] : userAgent;

    public static string From(string userAgent)
    {
        var browser = userAgent.Contains("Firefox/", StringComparison.Ordinal) ? "Firefox"
            : userAgent.Contains("Edg/", StringComparison.Ordinal) ? "Edge"
            : userAgent.Contains("Chrom", StringComparison.Ordinal) ? "Chrome"
            : userAgent.Contains("Safari/", StringComparison.Ordinal) ? "Safari"
            : "Przeglądarka";
        var system = userAgent.Contains("Windows", StringComparison.Ordinal) ? "Windows"
            : userAgent.Contains("Android", StringComparison.Ordinal) ? "Android"
            : userAgent.Contains("iPhone", StringComparison.Ordinal) || userAgent.Contains("iPad", StringComparison.Ordinal) ? "iOS"
            : userAgent.Contains("Mac OS", StringComparison.Ordinal) ? "macOS"
            : userAgent.Contains("Linux", StringComparison.Ordinal) ? "Linux"
            : "nieznany system";
        return $"{browser} · {system}";
    }
}

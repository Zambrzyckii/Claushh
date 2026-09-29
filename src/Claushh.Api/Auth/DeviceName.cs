// The User-Agent as it is stored with sessions and login attempts (docs/ARCHITECTURE.md, "Backend").
namespace Claushh.Api.Auth;

public static class DeviceName
{
    private const int MaxStoredLength = 256;

    public static string Stored(string userAgent) =>
        userAgent.Length > MaxStoredLength ? userAgent[..MaxStoredLength] : userAgent;
}

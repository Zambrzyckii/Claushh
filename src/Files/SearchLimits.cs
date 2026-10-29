// The limits of search in files (docs/ARCHITECTURE.md, "Backend" → "Files"): constants, as every limit of the API, and the
// time limit in this singleton, which only the tests change (ApiFactory.SetSearchTime).
namespace Claushh.Api.Files;

public sealed class SearchLimits
{
    public const int MaxMatches = 2_000;
    public const long MaxFileBytes = 1024 * 1024;
    public static readonly TimeSpan DefaultTime = TimeSpan.FromSeconds(10);

    public TimeSpan Time { get; set; } = DefaultTime;
}

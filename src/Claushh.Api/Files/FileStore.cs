// Reading and saving files for the editor: versions, the size limit, text checks and saves that never leave a
// half-written file (docs/ARCHITECTURE.md, "Files and editor"; decisions: docs/PLAN.md, "Backend decisions (stage 2)").
using System.Security.Cryptography;
using System.Text;

namespace Claushh.Api.Files;

public enum ReadStatus { Ok, NotFound, TooLarge, NotText }

public sealed record ReadResult(ReadStatus Status, string Content = "", string Version = "");

public enum SaveStatus { Saved, Invalid, NotFound, Conflict, TooLarge }

// Version: of the file now on disk (Saved), or the one that is there instead of the expected one (Conflict).
public sealed record SaveResult(SaveStatus Status, string Version = "");

public sealed class FileStore
{
    public const int MaxBytes = 5 * 1024 * 1024;
    public const string AbsentVersion = "absent";

    private static readonly byte[] Bom = [0xEF, 0xBB, 0xBF];
    private static readonly UTF8Encoding StrictUtf8 = new(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: true);

    // Saves of one file run one at a time; two files share a lock only when their paths hash alike.
    private readonly SemaphoreSlim[] _locks = Enumerable.Range(0, 64).Select(_ => new SemaphoreSlim(1, 1)).ToArray();

    public async Task<ReadResult> ReadAsync(ProjectPath file, CancellationToken ct)
    {
        if (file.Kind != PathKind.File)
        {
            return new(ReadStatus.NotFound);
        }
        byte[] bytes;
        try
        {
            if (new FileInfo(file.FullPath).Length > MaxBytes)
            {
                return new(ReadStatus.TooLarge);
            }
            bytes = await ReadAtMostAsync(file.FullPath, MaxBytes + 1, ct);
        }
        catch (Exception e) when (e is FileNotFoundException or DirectoryNotFoundException)
        {
            return new(ReadStatus.NotFound);
        }
        if (bytes.Length > MaxBytes)
        {
            return new(ReadStatus.TooLarge);
        }
        var text = DecodeText(bytes);
        return text is null ? new(ReadStatus.NotText) : new(ReadStatus.Ok, text, VersionOf(bytes));
    }

    public async Task<SaveResult> SaveAsync(ProjectPath file, string content, string baseVersion, CancellationToken ct)
    {
        switch (file.Kind)
        {
            case PathKind.NotFound:
                return new(SaveStatus.NotFound);
            case PathKind.Directory or PathKind.Other:
                return new(SaveStatus.Invalid);
        }
        byte[] text;
        try
        {
            text = StrictUtf8.GetBytes(content);
        }
        catch (EncoderFallbackException)
        {
            // A lone UTF-16 surrogate cannot be written as UTF-8.
            return new(SaveStatus.Invalid);
        }
        if (text.Length > MaxBytes)
        {
            return new(SaveStatus.TooLarge);
        }
        var fileLock = _locks[(uint)StringComparer.Ordinal.GetHashCode(file.FullPath) % (uint)_locks.Length];
        await fileLock.WaitAsync(ct);
        try
        {
            var current = await CurrentAsync(file.FullPath, ct);
            var currentVersion = current?.Version ?? AbsentVersion;
            if (currentVersion != baseVersion)
            {
                return new(SaveStatus.Conflict, currentVersion);
            }
            byte[] bytes = current is { Bom: true } ? [.. Bom, .. text] : text;
            if (bytes.Length > MaxBytes)
            {
                return new(SaveStatus.TooLarge);
            }
            try
            {
                await WriteAtomicallyAsync(file.FullPath, bytes, keepMode: current is not null, ct);
            }
            catch (DirectoryNotFoundException)
            {
                return new(SaveStatus.NotFound);
            }
            return new(SaveStatus.Saved, VersionOf(bytes));
        }
        finally
        {
            fileLock.Release();
        }
    }

    // What the editor shows for the bytes of a file: null for a NUL byte or invalid UTF-8, otherwise the text without a
    // leading UTF-8 BOM. The size limit (MaxBytes) is up to the caller.
    internal static string? DecodeText(ReadOnlySpan<byte> bytes)
    {
        if (bytes.Contains((byte)0))
        {
            return null;
        }
        try
        {
            return StrictUtf8.GetString(bytes[(HasBom(bytes) ? Bom.Length : 0)..]);
        }
        catch (DecoderFallbackException)
        {
            return null;
        }
    }

    private static string VersionOf(ReadOnlySpan<byte> bytes) => Convert.ToHexStringLower(SHA256.HashData(bytes));

    private static bool HasBom(ReadOnlySpan<byte> bytes) => bytes.StartsWith(Bom);

    private static async Task<byte[]> ReadAtMostAsync(string path, int limit, CancellationToken ct)
    {
        await using var stream = File.OpenRead(path);
        var buffer = new byte[limit];
        var read = await stream.ReadAtLeastAsync(buffer, limit, throwOnEndOfStream: false, ct);
        return buffer[..read];
    }

    // The version and the BOM of the file now on disk, hashed as a stream (it may have grown past the limit); null
    // when there is no file.
    private static async Task<(string Version, bool Bom)?> CurrentAsync(string path, CancellationToken ct)
    {
        try
        {
            await using var stream = File.OpenRead(path);
            var head = new byte[Bom.Length];
            var read = await stream.ReadAtLeastAsync(head, head.Length, throwOnEndOfStream: false, ct);
            stream.Position = 0;
            var hash = await SHA256.HashDataAsync(stream, ct);
            return (Convert.ToHexStringLower(hash), read == Bom.Length && HasBom(head));
        }
        catch (Exception e) when (e is FileNotFoundException or DirectoryNotFoundException)
        {
            return null;
        }
    }

    // Written next to the file, flushed to disk, then renamed over it: readers see the old or the new file, never half.
    private static async Task WriteAtomicallyAsync(string path, byte[] bytes, bool keepMode, CancellationToken ct)
    {
        var temporary = Path.Join(Path.GetDirectoryName(path), $".{Path.GetFileName(path)}.claushh-{Guid.NewGuid():N}.tmp");
        try
        {
            await using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                await stream.WriteAsync(bytes, ct);
                stream.Flush(flushToDisk: true);
            }
            if (keepMode)
            {
                File.SetUnixFileMode(temporary, File.GetUnixFileMode(path));
            }
            File.Move(temporary, path, overwrite: true);
        }
        catch
        {
            File.Delete(temporary);
            throw;
        }
    }
}

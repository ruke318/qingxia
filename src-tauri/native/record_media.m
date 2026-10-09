#import <AVFoundation/AVFoundation.h>
#import <CoreMedia/CoreMedia.h>
#include <math.h>
#include <stdio.h>
#include <unistd.h>

static int fail(char *message, size_t capacity, NSString *reason) {
    if (capacity) snprintf(message, capacity, "%s", reason.UTF8String ?: "静音录像重封装失败");
    return -1;
}

static AVAssetReader *readerFor(AVAsset *asset, AVAssetTrack *track, AVAssetReaderTrackOutput **output, NSError **error) {
    AVAssetReader *reader = [[AVAssetReader alloc] initWithAsset:asset error:error];
    if (!reader) return nil;
    *output = [[AVAssetReaderTrackOutput alloc] initWithTrack:track outputSettings:nil];
    (*output).alwaysCopiesSampleData = NO;
    if (![reader canAddOutput:*output]) return nil;
    [reader addOutput:*output];
    return [reader startReading] ? reader : nil;
}

// 此桥只做完成后的无声压缩重封装，不捕获、不解码、不改变前段速度。
// 返回 0 为无需延长，1 为生成替换文件，-1 为保留原文件并报告失败。
int qingbox_normalize_silent(const char *source, const char *destination, double seconds, char *message, size_t capacity) {
    @autoreleasepool {
        if (!isfinite(seconds) || seconds <= 0) return fail(message, capacity, @"录制目标时长无效");
        AVURLAsset *asset = [AVURLAsset URLAssetWithURL:[NSURL fileURLWithPath:@(source)] options:nil];
        AVAssetTrack *track = [asset tracksWithMediaType:AVMediaTypeVideo].firstObject;
        if (!track) return fail(message, capacity, @"完成文件没有视频轨道");
        NSError *error = nil;
        AVAssetReaderTrackOutput *output = nil;
        AVAssetReader *scan = readerFor(asset, track, &output, &error);
        if (!scan) return fail(message, capacity, error.localizedDescription ?: @"不能读取完成录像");
        CMTime finalDecode = kCMTimeInvalid, presentationEnd = kCMTimeInvalid;
        size_t count = 0;
        CMSampleBufferRef sample;
        while ((sample = [output copyNextSampleBuffer])) {
            if (CMSampleBufferGetNumSamples(sample) > 0) {
                CMTime pts = CMSampleBufferGetOutputPresentationTimeStamp(sample);
                CMTime dts = CMSampleBufferGetOutputDecodeTimeStamp(sample);
                CMTime duration = CMSampleBufferGetOutputDuration(sample);
                if (!CMTIME_IS_NUMERIC(pts) || !CMTIME_IS_NUMERIC(dts) || !CMTIME_IS_NUMERIC(duration)) {
                    CFRelease(sample); [scan cancelReading]; return fail(message, capacity, @"完成录像的有效样本时间不正确");
                }
                CMTime end = CMTimeAdd(pts, duration);
                if (!CMTIME_IS_NUMERIC(finalDecode) || CMTimeCompare(dts, finalDecode) > 0) finalDecode = dts;
                if (!CMTIME_IS_NUMERIC(presentationEnd) || CMTimeCompare(end, presentationEnd) > 0) presentationEnd = end;
                count++;
            }
            CFRelease(sample);
        }
        if (scan.status != AVAssetReaderStatusCompleted || !count) return fail(message, capacity, scan.error.localizedDescription ?: @"完成录像没有有效视频样本");
        CMTime intended = CMTimeMakeWithSeconds(seconds, 60000);
        // 已覆盖录制时长的文件必须逐字节保留，不导出或裁剪。
        if (CMTimeCompare(intended, presentationEnd) <= 0) return 0;
        NSURL *destinationURL = [NSURL fileURLWithPath:@(destination)];
        AVAssetWriter *writer = [[AVAssetWriter alloc] initWithURL:destinationURL fileType:AVFileTypeMPEG4 error:&error];
        if (!writer) return fail(message, capacity, error.localizedDescription ?: @"不能创建重封装文件");
        AVAssetWriterInput *input = [AVAssetWriterInput assetWriterInputWithMediaType:AVMediaTypeVideo outputSettings:nil sourceFormatHint:(__bridge CMFormatDescriptionRef)track.formatDescriptions.firstObject];
        input.transform = track.preferredTransform;
        if (![writer canAddInput:input]) return fail(message, capacity, @"不能添加压缩视频输出");
        [writer addInput:input];
        if (![writer startWriting]) return fail(message, capacity, writer.error.localizedDescription ?: @"不能开始视频重封装");
        [writer startSessionAtSourceTime:kCMTimeZero];
        AVAssetReader *reader = readerFor(asset, track, &output, &error);
        if (!reader) { [writer cancelWriting]; return fail(message, capacity, error.localizedDescription ?: @"不能重新读取完成录像"); }
        BOOL replaced = NO;
        while ((sample = [output copyNextSampleBuffer])) {
            if (CMSampleBufferGetNumSamples(sample) == 0) { CFRelease(sample); continue; }
            CMTime pts = CMSampleBufferGetOutputPresentationTimeStamp(sample);
            CMTime dts = CMSampleBufferGetOutputDecodeTimeStamp(sample);
            if (CMTimeCompare(dts, finalDecode) == 0) {
                CMSampleTimingInfo timing = { CMTimeAdd(CMSampleBufferGetOutputDuration(sample), CMTimeSubtract(intended, presentationEnd)), pts, dts };
                CMSampleBufferRef replacement = NULL;
                OSStatus status = CMSampleBufferCreateCopyWithNewTiming(kCFAllocatorDefault, sample, 1, &timing, &replacement);
                CFRelease(sample);
                if (status != noErr || !replacement) { [reader cancelReading]; [writer cancelWriting]; return fail(message, capacity, @"不能延长最后解码样本"); }
                sample = replacement; replaced = YES;
            }
            CFAbsoluteTime deadline = CFAbsoluteTimeGetCurrent() + 30;
            while (!input.readyForMoreMediaData && writer.status == AVAssetWriterStatusWriting && CFAbsoluteTimeGetCurrent() < deadline) usleep(1000);
            BOOL appended = input.readyForMoreMediaData && [input appendSampleBuffer:sample];
            CFRelease(sample);
            if (!appended) { [reader cancelReading]; [writer cancelWriting]; return fail(message, capacity, writer.error.localizedDescription ?: @"视频重封装等待超时"); }
        }
        if (reader.status != AVAssetReaderStatusCompleted || !replaced) { [writer cancelWriting]; return fail(message, capacity, reader.error.localizedDescription ?: @"未完成最后视频样本的重封装"); }
        [input markAsFinished];
        [writer endSessionAtSourceTime:intended];
        dispatch_semaphore_t finished = dispatch_semaphore_create(0);
        [writer finishWritingWithCompletionHandler:^{ dispatch_semaphore_signal(finished); }];
        if (dispatch_semaphore_wait(finished, dispatch_time(DISPATCH_TIME_NOW, 30 * NSEC_PER_SEC))) { [writer cancelWriting]; return fail(message, capacity, @"等待静音视频重封装完成超时"); }
        if (writer.status != AVAssetWriterStatusCompleted) return fail(message, capacity, writer.error.localizedDescription ?: @"静音视频重封装失败");
        return 1;
    }
}

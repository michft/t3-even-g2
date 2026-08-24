#import "T3EvenG2LC3Decoder.h"

#import "lc3.h"

static const int T3EvenG2FrameDurationUs = 10000;
static const int T3EvenG2SampleRateHz = 16000;
static const NSUInteger T3EvenG2PacketBytes = 205;
static const NSUInteger T3EvenG2FrameBytes = 40;
static const NSUInteger T3EvenG2FramesPerPacket = 5;

@interface T3EvenG2LC3Decoder () {
  void *_decoderMemory;
  lc3_decoder_t _decoder;
  NSUInteger _samplesPerFrame;
}
@end

@implementation T3EvenG2LC3Decoder

- (instancetype)init {
  self = [super init];
  if (self) {
    _samplesPerFrame = (NSUInteger)lc3_frame_samples(T3EvenG2FrameDurationUs, T3EvenG2SampleRateHz);
    _decoderMemory = calloc(1, lc3_decoder_size(T3EvenG2FrameDurationUs, T3EvenG2SampleRateHz));
    if (_decoderMemory != NULL) {
      _decoder = lc3_setup_decoder(
        T3EvenG2FrameDurationUs,
        T3EvenG2SampleRateHz,
        0,
        _decoderMemory
      );
    }
  }
  return self;
}

- (void)dealloc {
  free(_decoderMemory);
}

- (nullable NSData *)decodePacket:(NSData *)packet error:(NSError * _Nullable * _Nullable)error {
  if (_decoder == NULL || packet.length != T3EvenG2PacketBytes) {
    if (error != NULL) {
      *error = [NSError errorWithDomain:@"T3EvenG2LC3"
                                   code:1
                               userInfo:@{NSLocalizedDescriptionKey: @"Invalid G2 LC3 packet."}];
    }
    return nil;
  }

  const uint8_t *input = packet.bytes;
  const NSUInteger totalSamples = _samplesPerFrame * T3EvenG2FramesPerPacket;
  NSMutableData *pcm = [NSMutableData dataWithLength:totalSamples * sizeof(int16_t)];
  int16_t *output = pcm.mutableBytes;

  for (NSUInteger frame = 0; frame < T3EvenG2FramesPerPacket; frame += 1) {
    const int result = lc3_decode(
      _decoder,
      input + (frame * T3EvenG2FrameBytes),
      (int)T3EvenG2FrameBytes,
      LC3_PCM_FORMAT_S16,
      output + (frame * _samplesPerFrame),
      1
    );
    if (result < 0) {
      if (error != NULL) {
        *error = [NSError errorWithDomain:@"T3EvenG2LC3"
                                     code:2
                                 userInfo:@{NSLocalizedDescriptionKey: @"G2 LC3 decode failed."}];
      }
      return nil;
    }
  }

  return pcm;
}

@end

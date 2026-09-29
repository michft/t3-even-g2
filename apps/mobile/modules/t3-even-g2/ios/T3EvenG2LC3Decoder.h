#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface T3EvenG2LC3Decoder : NSObject

/// Decodes one G2 LC3 packet into interleaved-frame mono Int16 PCM, or reports an error.
- (nullable NSData *)decodePacket:(NSData *)packet error:(NSError * _Nullable * _Nullable)error;

@end

NS_ASSUME_NONNULL_END

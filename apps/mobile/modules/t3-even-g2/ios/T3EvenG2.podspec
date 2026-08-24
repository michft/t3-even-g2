Pod::Spec.new do |s|
  s.name             = 'T3EvenG2'
  s.version          = '1.0.0'
  s.summary          = 'Direct Even Realities G2 bridge for T3 Code Mobile.'
  s.description      = 'CoreBluetooth transport, LC3 microphone decoding, SpeechAnalyzer transcription, and lens text output.'
  s.author           = 'T3 Tools'
  s.homepage         = 'https://t3tools.com'
  s.platforms        = { :ios => '18.0' }
  s.source           = { :path => '.' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'AVFoundation', 'CoreBluetooth', 'Speech'
  s.source_files = '**/*.{h,m,mm,swift,c}'
  s.public_header_files = 'T3EvenG2LC3Decoder.h'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'HEADER_SEARCH_PATHS' => '"${PODS_TARGET_SRCROOT}/vendor/lc3"',
  }
end

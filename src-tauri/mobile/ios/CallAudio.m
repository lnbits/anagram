#import <AVFoundation/AVFoundation.h>
#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
#include <stdbool.h>

// WKWebView capture can change the session's category when video is enabled.
// Keep the voice route for the duration of the call, without a polling timer.
static BOOL callActive = NO;
static BOOL loudspeaker = NO;
static BOOL applying = NO;
static NSString *previousCategory;
static NSString *previousMode;
static AVAudioSessionCategoryOptions previousOptions;
static id routeObserver;
static id resetObserver;
static id interruptionObserver;
static id foregroundObserver;
static BOOL interrupted = NO;
static BOOL previousIdleTimerDisabled;

static BOOL applyRoute(void) {
    if (!callActive || applying || interrupted) return YES;
    applying = YES;
    AVAudioSession *session = AVAudioSession.sharedInstance;
    NSError *error = nil;
    // VoiceChat supports HFP headsets and, unlike VideoChat, does not imply
    // DefaultToSpeaker. Wired/Bluetooth routes retain the system's priority.
    AVAudioSessionCategoryOptions options = AVAudioSessionCategoryOptionAllowBluetooth;
    if (loudspeaker) options |= AVAudioSessionCategoryOptionDefaultToSpeaker;
    BOOL ok = YES;
    if (![session.category isEqualToString:AVAudioSessionCategoryPlayAndRecord] ||
        ![session.mode isEqualToString:AVAudioSessionModeVoiceChat] || session.categoryOptions != options) {
        ok = [session setCategory:AVAudioSessionCategoryPlayAndRecord
                            mode:AVAudioSessionModeVoiceChat options:options error:&error];
    }
    if (ok) ok = [session setActive:YES error:&error];
    AVAudioSessionPortDescription *output = session.currentRoute.outputs.firstObject;
    // .none restores normal receiver/headset routing; it never forces audio
    // out of headphones. Avoid repeated overrides from our own notifications.
    BOOL isSpeaker = [output.portType isEqualToString:AVAudioSessionPortBuiltInSpeaker];
    BOOL hasReceiver = [UIDevice.currentDevice.model hasPrefix:@"iPhone"];
    if (ok && isSpeaker != loudspeaker && (loudspeaker || hasReceiver)) {
        ok = [session overrideOutputAudioPort:loudspeaker ? AVAudioSessionPortOverrideSpeaker : AVAudioSessionPortOverrideNone error:&error];
    }
    applying = NO;
    return ok;
}

bool anagram_set_call_audio(bool active, bool speaker) {
    NSCAssert(NSThread.isMainThread, @"Call routing requires the main thread");
    AVAudioSession *session = AVAudioSession.sharedInstance;
    if (!active) {
        if (!callActive) return true;
        callActive = NO;
        [NSNotificationCenter.defaultCenter removeObserver:routeObserver];
        [NSNotificationCenter.defaultCenter removeObserver:resetObserver];
        [NSNotificationCenter.defaultCenter removeObserver:interruptionObserver];
        [NSNotificationCenter.defaultCenter removeObserver:foregroundObserver];
        routeObserver = resetObserver = nil;
        interruptionObserver = foregroundObserver = nil;
        interrupted = NO;
        UIApplication.sharedApplication.idleTimerDisabled = previousIdleTimerDisabled;
        [session overrideOutputAudioPort:AVAudioSessionPortOverrideNone error:NULL];
        [session setActive:NO withOptions:AVAudioSessionSetActiveOptionNotifyOthersOnDeactivation error:NULL];
        BOOL ok = [session setCategory:previousCategory mode:previousMode options:previousOptions error:NULL];
        previousCategory = previousMode = nil;
        loudspeaker = NO;
        return ok;
    }
    if (!callActive) {
        previousCategory = session.category;
        previousMode = session.mode;
        previousOptions = session.categoryOptions;
        previousIdleTimerDisabled = UIApplication.sharedApplication.idleTimerDisabled;
        UIApplication.sharedApplication.idleTimerDisabled = YES;
        callActive = YES;
        void (^changed)(NSNotification *) = ^(NSNotification *notification) {
            if (callActive) applyRoute();
        };
        routeObserver = [NSNotificationCenter.defaultCenter addObserverForName:AVAudioSessionRouteChangeNotification
            object:session queue:NSOperationQueue.mainQueue usingBlock:changed];
        resetObserver = [NSNotificationCenter.defaultCenter addObserverForName:AVAudioSessionMediaServicesWereResetNotification
            object:session queue:NSOperationQueue.mainQueue usingBlock:changed];
        foregroundObserver = [NSNotificationCenter.defaultCenter addObserverForName:UIApplicationDidBecomeActiveNotification
            object:nil queue:NSOperationQueue.mainQueue usingBlock:changed];
        interruptionObserver = [NSNotificationCenter.defaultCenter addObserverForName:AVAudioSessionInterruptionNotification
            object:session queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *notification) {
                if (!callActive) return;
                interrupted = [notification.userInfo[AVAudioSessionInterruptionTypeKey] unsignedIntegerValue]
                    == AVAudioSessionInterruptionTypeBegan;
                if (!interrupted && ([notification.userInfo[AVAudioSessionInterruptionOptionKey] unsignedIntegerValue]
                    & AVAudioSessionInterruptionOptionShouldResume)) applyRoute();
            }];
    }
    BOOL previous = loudspeaker;
    loudspeaker = speaker;
    BOOL ok = applyRoute();
    if (!ok) loudspeaker = previous;
    return ok;
}

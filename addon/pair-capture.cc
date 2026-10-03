#define NOMINMAX
#include <napi.h>
#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#if __has_include(<audioclientactivationparams.h>)
#include <audioclientactivationparams.h>
#else
// MinGW's SDK can lag the process-loopback declarations even though the ABI is
// part of supported Windows 10/11. Keep the official layout locally so release
// cross-builds and current MSVC builds produce the same activation blob.
typedef enum AUDIOCLIENT_ACTIVATION_TYPE {
  AUDIOCLIENT_ACTIVATION_TYPE_DEFAULT,
  AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK
} AUDIOCLIENT_ACTIVATION_TYPE;
typedef enum PROCESS_LOOPBACK_MODE {
  PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
  PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE
} PROCESS_LOOPBACK_MODE;
typedef struct AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
  DWORD TargetProcessId;
  PROCESS_LOOPBACK_MODE ProcessLoopbackMode;
} AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS;
typedef struct AUDIOCLIENT_ACTIVATION_PARAMS {
  AUDIOCLIENT_ACTIVATION_TYPE ActivationType;
  union { AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS ProcessLoopbackParams; };
} AUDIOCLIENT_ACTIVATION_PARAMS;
#ifndef VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK
#define VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK L"VAD\\Process_Loopback"
#endif
#endif
#include <mmreg.h>
#include <propvarutil.h>
#include <thread>
#include <atomic>
#include <chrono>
#include <cstring>
#include <cstdlib>
#include <cstdint>
#include <string>

// Bump this whenever the native/JavaScript capture contract changes. Release
// packaging verifies that the compiled PE contains this exact marker and that
// its manifest hashes the current source, so an older addon cannot silently be
// copied into a new installer.
static constexpr char kCaptureAbi[] = "knot-screen-audio-v4";
static constexpr DWORD kActivationTimeoutMs = 5000;
static constexpr DWORD kCaptureStopTimeoutMs = 1500;
static constexpr DWORD kCaptureCancelTimeoutMs = 500;

// Windows process loopback lets us capture the system mix while excluding
// Knot's process tree. This is the same class of capture Discord uses to keep
// its own voice playback out of a stream. Windows 10 needs a recent update for
// it; without one, start() can fall back to the default output's whole mix.
class ActivationHandler final : public IActivateAudioInterfaceCompletionHandler, public IAgileObject {
  std::atomic<ULONG> refs{1};
  HANDLE eventHandle=nullptr;
  HRESULT result=E_FAIL;
  IAudioClient* client=nullptr;
public:
  ActivationHandler(){eventHandle=CreateEvent(nullptr,FALSE,FALSE,nullptr);}
  ~ActivationHandler(){if(eventHandle)CloseHandle(eventHandle);if(client)client->Release();}
  HANDLE event()const{return eventHandle;}
  HRESULT activationResult()const{return result;}
  IAudioClient* takeClient(){auto* value=client;client=nullptr;return value;}
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void** out) override {
    if(!out)return E_POINTER;
    *out=nullptr;
    if(iid==__uuidof(IUnknown)||iid==__uuidof(IActivateAudioInterfaceCompletionHandler)) *out=static_cast<IActivateAudioInterfaceCompletionHandler*>(this);
    else if(iid==__uuidof(IAgileObject)) *out=static_cast<IAgileObject*>(this);
    else return E_NOINTERFACE;
    AddRef();return S_OK;
  }
  ULONG STDMETHODCALLTYPE AddRef() override{return ++refs;}
  ULONG STDMETHODCALLTYPE Release() override{ULONG n=--refs;if(!n)delete this;return n;}
  HRESULT STDMETHODCALLTYPE ActivateCompleted(IActivateAudioInterfaceAsyncOperation* operation) override {
    HRESULT activation=E_FAIL;IUnknown* unknown=nullptr;
    HRESULT hr=operation?operation->GetActivateResult(&activation,&unknown):E_POINTER;
    if(SUCCEEDED(hr)&&SUCCEEDED(activation)&&unknown) hr=unknown->QueryInterface(__uuidof(IAudioClient),(void**)&client);
    if(unknown)unknown->Release();
    result=FAILED(hr)?hr:activation;
    if(eventHandle)SetEvent(eventHandle);
    return S_OK;
  }
};

class Capture {
public:
  std::atomic<bool> runningFlag{false};

  IMMDeviceEnumerator* enumerator=nullptr;
  IMMDevice* device=nullptr;
  IAudioClient* audioClient=nullptr;
  IAudioCaptureClient* captureClient=nullptr;
  WAVEFORMATEX* mixFormat=nullptr;
  UINT32 bufFrames=0;
  HANDLE captureEvent=nullptr;
  bool comInitialized=false;
  // Process loopback signals its event per packet. The whole-device fallback
  // is polled instead: loopback event delivery is not reliable on every
  // Windows 10 audio driver.
  bool eventDriven=true;
  bool isolated=true;
  bool floatSamples=false;
  HRESULT isolationError=S_OK;
  // Process isolation cannot appear without an OS update, and a failed
  // activation can take its full timeout. Go straight to the fallback after
  // the first failure instead of paying that delay on every start.
  HRESULT knownIsolationError=S_OK;
  std::thread captureThread;
  Napi::ThreadSafeFunction dataCb,errCb;

  Capture()=default;
  ~Capture(){stop();}

  void start(Napi::Function dataCbFn,Napi::Function errCbFn,DWORD targetPid,bool includeTarget,bool allowSystemMix){
    if(runningFlag.load())return;
    dataCb=Napi::ThreadSafeFunction::New(
      dataCbFn.Env(),dataCbFn,Napi::String::New(dataCbFn.Env(),"data"),4,1
    );
    errCb=Napi::ThreadSafeFunction::New(
      errCbFn.Env(),errCbFn,Napi::String::New(errCbFn.Env(),"err"),1,1
    );
    HRESULT hr=initWasapi(targetPid,includeTarget,allowSystemMix);
    if(FAILED(hr)){
      if(dataCb){dataCb.Release();dataCb=nullptr;}
      if(errCb){errCb.Release();errCb=nullptr;}
      cleanup();
      char m[128];sprintf(m,"WASAPI init failed: 0x%08lX",(unsigned long)hr);
      throw Napi::Error::New(dataCbFn.Env(),m);
    }
    runningFlag.store(true);
    captureThread=std::thread(&Capture::loop,this);
  }

  void stop(){
    runningFlag.store(false);
    if(captureEvent)SetEvent(captureEvent);
    if(captureThread.joinable()){
      HANDLE threadHandle=(HANDLE)captureThread.native_handle();
      DWORD wait=WaitForSingleObject(threadHandle,kCaptureStopTimeoutMs);
      if(wait==WAIT_TIMEOUT){
        CancelSynchronousIo(threadHandle);
        if(captureEvent)SetEvent(captureEvent);
        wait=WaitForSingleObject(threadHandle,kCaptureCancelTimeoutMs);
      }
      // WASAPI calls should have returned after the event/cancellation above.
      // As a last-resort shutdown guard, terminate only this capture worker so
      // Electron's main thread can never hang forever during app/share teardown.
      if(wait==WAIT_TIMEOUT){TerminateThread(threadHandle,ERROR_OPERATION_ABORTED);WaitForSingleObject(threadHandle,kCaptureCancelTimeoutMs);}
      captureThread.join();
    }
    if(dataCb){dataCb.Release();dataCb=nullptr;}
    if(errCb){errCb.Release();errCb=nullptr;}
    cleanup();
  }

  Napi::Object getFormat(Napi::Env env){
    auto o=Napi::Object::New(env);
    if(!mixFormat){o.Set("available",Napi::Boolean::New(env,false));return o;}
    o.Set("sampleRate",Napi::Number::New(env,(double)mixFormat->nSamplesPerSec));
    o.Set("channels",Napi::Number::New(env,(double)mixFormat->nChannels));
    o.Set("bitsPerSample",Napi::Number::New(env,(double)mixFormat->wBitsPerSample));
    o.Set("sampleType",Napi::String::New(env,floatSamples?"float":"pcm"));
    o.Set("isolated",Napi::Boolean::New(env,isolated));
    o.Set("mode",Napi::String::New(env,isolated?"process-loopback":"system-mix"));
    if(FAILED(isolationError)){
      char code[16];sprintf(code,"0x%08lX",(unsigned long)isolationError);
      o.Set("isolationError",Napi::String::New(env,code));
    }
    return o;
  }

private:
  HRESULT initWasapi(DWORD targetPid,bool includeTarget,bool allowSystemMix){
    HRESULT hr=CoInitializeEx(nullptr,COINIT_APARTMENTTHREADED);
    if(SUCCEEDED(hr))comInitialized=true;
    else if(hr!=RPC_E_CHANGED_MODE)return hr;
    isolated=true;eventDriven=true;isolationError=S_OK;
    hr=allowSystemMix&&FAILED(knownIsolationError)?knownIsolationError:initProcessLoopback(targetPid,includeTarget);
    if(SUCCEEDED(hr)||!allowSystemMix)return hr;
    knownIsolationError=hr;
    // Windows 10 releases without the process-loopback update reject the
    // virtual device. The default output's loopback works everywhere, but it
    // includes Knot's own playback, so the renderer labels it as such.
    isolationError=hr;
    releaseStream();
    hr=initSystemMix();
    if(SUCCEEDED(hr)){isolated=false;eventDriven=false;}
    return hr;
  }

  HRESULT initProcessLoopback(DWORD targetPid,bool includeTarget){
    HRESULT hr=S_OK;

    // A window/application share captures its owning process and descendants,
    // matching Discord's application-audio model. A full-display share captures
    // every render stream except Knot and its descendants, so voice playback can
    // never be sent back to the person watching.
    AUDIOCLIENT_ACTIVATION_PARAMS params={};
    params.ActivationType=AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
    params.ProcessLoopbackParams.TargetProcessId=targetPid?targetPid:GetCurrentProcessId();
    params.ProcessLoopbackParams.ProcessLoopbackMode=includeTarget?PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE:PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE;
    PROPVARIANT prop={};
    prop.vt=VT_BLOB;prop.blob.cbSize=sizeof(params);prop.blob.pBlobData=(BYTE*)&params;
    auto* handler=new ActivationHandler();
    if(!handler->event()){handler->Release();return HRESULT_FROM_WIN32(GetLastError());}
    // Resolve dynamically: older SDK link libraries do not always export this
    // newer API even though supported Windows releases do. That lets one addon
    // run on both current and older Windows without a loader failure.
    HMODULE audioApi=LoadLibraryW(L"mmdevapi.dll");
    auto activate=audioApi?reinterpret_cast<decltype(&ActivateAudioInterfaceAsync)>(GetProcAddress(audioApi,"ActivateAudioInterfaceAsync")):nullptr;
    IActivateAudioInterfaceAsyncOperation* operation=nullptr;
    hr=activate?activate(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,__uuidof(IAudioClient),&prop,handler,&operation):HRESULT_FROM_WIN32(ERROR_PROC_NOT_FOUND);
    if(FAILED(hr)){
      if(audioApi)FreeLibrary(audioApi);handler->Release();
      return hr;
    }
    const DWORD activationWait=WaitForSingleObject(handler->event(),kActivationTimeoutMs);
    if(operation)operation->Release();
    if(audioApi)FreeLibrary(audioApi);
    if(activationWait!=WAIT_OBJECT_0){handler->Release();return activationWait==WAIT_TIMEOUT?HRESULT_FROM_WIN32(ERROR_TIMEOUT):HRESULT_FROM_WIN32(GetLastError());}
    hr=handler->activationResult();
    if(SUCCEEDED(hr))audioClient=handler->takeClient();
    handler->Release();
    if(FAILED(hr)||!audioClient)return FAILED(hr)?hr:E_FAIL;

    // Request a predictable PCM format. Windows converts the process mix for
    // us, which keeps the Node bridge's real-time samples simple and stable.
    auto* requested=(WAVEFORMATEX*)CoTaskMemAlloc(sizeof(WAVEFORMATEX));
    if(!requested)return E_OUTOFMEMORY;
    ZeroMemory(requested,sizeof(WAVEFORMATEX));
    requested->wFormatTag=WAVE_FORMAT_PCM;requested->nChannels=2;requested->nSamplesPerSec=48000;requested->wBitsPerSample=16;
    requested->nBlockAlign=requested->nChannels*requested->wBitsPerSample/8;requested->nAvgBytesPerSec=requested->nSamplesPerSec*requested->nBlockAlign;
    mixFormat=requested;
    hr=audioClient->Initialize(AUDCLNT_SHAREMODE_SHARED,AUDCLNT_STREAMFLAGS_LOOPBACK|AUDCLNT_STREAMFLAGS_EVENTCALLBACK|AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,0,0,mixFormat,nullptr);
    if(FAILED(hr))return hr;
    hr=readSampleLayout();
    if(FAILED(hr))return hr;
    hr=audioClient->GetBufferSize(&bufFrames);
    if(FAILED(hr))return hr;
    captureEvent=CreateEvent(nullptr,FALSE,FALSE,nullptr);
    if(!captureEvent)return E_FAIL;
    hr=audioClient->SetEventHandle(captureEvent);
    if(FAILED(hr))return hr;
    hr=audioClient->GetService(__uuidof(IAudioCaptureClient),(void**)&captureClient);
    if(FAILED(hr))return hr;
    // Start synchronously so an unavailable/invalid loopback endpoint makes the
    // start IPC fail immediately. Reporting only the initialized format while a
    // worker later fails to start produced a misleading silent "live" track.
    return audioClient->Start();
  }

  static WAVEFORMATEX* pcm48kStereo(){
    auto* format=(WAVEFORMATEX*)CoTaskMemAlloc(sizeof(WAVEFORMATEX));
    if(!format)return nullptr;
    ZeroMemory(format,sizeof(WAVEFORMATEX));
    format->wFormatTag=WAVE_FORMAT_PCM;format->nChannels=2;format->nSamplesPerSec=48000;format->wBitsPerSample=16;
    format->nBlockAlign=format->nChannels*format->wBitsPerSample/8;format->nAvgBytesPerSec=format->nSamplesPerSec*format->nBlockAlign;
    return format;
  }

  HRESULT initSystemMix(){
    HRESULT hr=CoCreateInstance(__uuidof(MMDeviceEnumerator),nullptr,CLSCTX_ALL,__uuidof(IMMDeviceEnumerator),(void**)&enumerator);
    if(FAILED(hr))return hr;
    hr=enumerator->GetDefaultAudioEndpoint(eRender,eConsole,&device);
    if(FAILED(hr))return hr;
    // 200 ms of shared buffer, drained every 10 ms by the polling loop.
    const REFERENCE_TIME bufferDuration=2000000;
    hr=device->Activate(__uuidof(IAudioClient),CLSCTX_ALL,nullptr,(void**)&audioClient);
    if(FAILED(hr))return hr;
    // Prefer the same 48 kHz stereo PCM as the isolated route. Not every
    // Windows 10 audio stack converts loopback streams, so fall back to the
    // device's own mix format and let the renderer resample it.
    mixFormat=pcm48kStereo();
    if(!mixFormat)return E_OUTOFMEMORY;
    hr=audioClient->Initialize(AUDCLNT_SHAREMODE_SHARED,AUDCLNT_STREAMFLAGS_LOOPBACK|AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM|AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,bufferDuration,0,mixFormat,nullptr);
    if(FAILED(hr)){
      CoTaskMemFree(mixFormat);mixFormat=nullptr;
      audioClient->Release();audioClient=nullptr;
      hr=device->Activate(__uuidof(IAudioClient),CLSCTX_ALL,nullptr,(void**)&audioClient);
      if(FAILED(hr))return hr;
      hr=audioClient->GetMixFormat(&mixFormat);
      if(FAILED(hr))return hr;
      hr=audioClient->Initialize(AUDCLNT_SHAREMODE_SHARED,AUDCLNT_STREAMFLAGS_LOOPBACK,bufferDuration,0,mixFormat,nullptr);
      if(FAILED(hr))return hr;
    }
    hr=readSampleLayout();
    if(FAILED(hr))return hr;
    hr=audioClient->GetBufferSize(&bufFrames);
    if(FAILED(hr))return hr;
    // Not registered with the client; stop() sets it to wake the poll early.
    captureEvent=CreateEvent(nullptr,FALSE,FALSE,nullptr);
    if(!captureEvent)return E_FAIL;
    hr=audioClient->GetService(__uuidof(IAudioCaptureClient),(void**)&captureClient);
    if(FAILED(hr))return hr;
    return audioClient->Start();
  }

  // Resolve WAVE_FORMAT_EXTENSIBLE to its sample type. KSDATAFORMAT_SUBTYPE_*
  // GUIDs carry the plain format tag in Data1.
  HRESULT readSampleLayout(){
    if(!mixFormat||mixFormat->nChannels<1||!mixFormat->nBlockAlign)return AUDCLNT_E_UNSUPPORTED_FORMAT;
    WORD tag=mixFormat->wFormatTag;
    if(tag==WAVE_FORMAT_EXTENSIBLE&&mixFormat->cbSize>=sizeof(WAVEFORMATEXTENSIBLE)-sizeof(WAVEFORMATEX))
      tag=(WORD)reinterpret_cast<WAVEFORMATEXTENSIBLE*>(mixFormat)->SubFormat.Data1;
    const WORD bits=mixFormat->wBitsPerSample;
    floatSamples=tag==WAVE_FORMAT_IEEE_FLOAT&&bits==32;
    if(floatSamples||(tag==WAVE_FORMAT_PCM&&(bits==16||bits==24||bits==32)))return S_OK;
    return AUDCLNT_E_UNSUPPORTED_FORMAT;
  }

  float sampleAt(const BYTE* frame,int channel)const{
    const int bytes=mixFormat->wBitsPerSample/8;
    const BYTE* p=frame+(size_t)channel*(size_t)bytes;
    if(floatSamples){float value;std::memcpy(&value,p,sizeof(value));return value;}
    if(bytes==2){INT16 value;std::memcpy(&value,p,sizeof(value));return value/32768.0f;}
    if(bytes==3){const INT32 value=(INT32)(((UINT32)p[0]<<8)|((UINT32)p[1]<<16)|((UINT32)p[2]<<24));return value/2147483648.0f;}
    INT32 value;std::memcpy(&value,p,sizeof(value));return value/2147483648.0f;
  }

  void loop(){
    HRESULT hr=S_OK;
    while(runningFlag.load()){
      const DWORD wait=WaitForSingleObject(captureEvent,eventDriven?500:10);
      if(!runningFlag.load())break;
      if(eventDriven&&wait!=WAIT_OBJECT_0)continue;
      UINT32 pktLen=0;
      hr=captureClient->GetNextPacketSize(&pktLen);
      if(FAILED(hr)){emitHr("GetNextPacketSize failed",hr);runningFlag.store(false);break;}
      while(pktLen>0&&runningFlag.load()){
        BYTE* data=nullptr;UINT32 frames=0;DWORD flags=0;
        hr=captureClient->GetBuffer(&data,&frames,&flags,nullptr,nullptr);
        if(FAILED(hr)){emitHr("GetBuffer failed",hr);runningFlag.store(false);break;}
        if(frames==0){captureClient->ReleaseBuffer(0);hr=captureClient->GetNextPacketSize(&pktLen);if(FAILED(hr)){emitHr("GetNextPacketSize failed",hr);runningFlag.store(false);}continue;}
        // Silent packets still prove that the loopback route is healthy. Emit
        // zeroes for them so the renderer can attach its WebRTC audio track
        // before desktop audio starts playing instead of falsely timing out.
        process(data,frames,(flags&AUDCLNT_BUFFERFLAGS_SILENT)!=0);
        captureClient->ReleaseBuffer(frames);
        hr=captureClient->GetNextPacketSize(&pktLen);
        if(FAILED(hr)){emitHr("GetNextPacketSize failed",hr);runningFlag.store(false);break;}
      }
    }
    audioClient->Stop();
  }

  void process(BYTE* data,UINT32 frames,bool silent=false){
    const int ch=mixFormat&&mixFormat->nChannels>0?mixFormat->nChannels:2;
    const int outCh=2;
    // Process loopback excludes Knot's process tree, so call playback is not in
    // this mix (the system-mix fallback is labelled instead). Keep a full
    // stereo pass-through for music/game audio instead of collapsing to mono or
    // running a soft canceller that can smear desktop sound.
    float* buf=(float*)calloc((size_t)frames*(size_t)outCh,sizeof(float));
    if(!buf)return;
    if(!silent&&data){
      const size_t stride=mixFormat->nBlockAlign;
      for(UINT32 i=0;i<frames;i++){
        const BYTE* frame=data+(size_t)i*stride;
        const float L=sampleAt(frame,0);
        buf[i*outCh+0]=L;
        buf[i*outCh+1]=ch>1?sampleAt(frame,1):L;
      }
    }
    // Silent or missing packets keep calloc's interleaved zeroes.

    UINT32 fCopy=frames;
    const auto capturedAtMs=std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::system_clock::now().time_since_epoch()).count();
    auto status=dataCb.NonBlockingCall([buf,fCopy,capturedAtMs](Napi::Env e,Napi::Function cb){
      auto ab=Napi::ArrayBuffer::New(e,buf,(size_t)fCopy*2*sizeof(float),[](Napi::Env, void* data){std::free(data);});
      cb.Call({ab,Napi::Number::New(e,(double)fCopy),Napi::Number::New(e,(double)capturedAtMs)});
    });
    if(status!=napi_ok){
      free(buf);
    }
  }

  void emitErr(const char* msg){
    const std::string message(msg ? msg : "unknown capture error");
    errCb.NonBlockingCall([message](Napi::Env e,Napi::Function cb){
      cb.Call({Napi::String::New(e,message)});
    });
  }

  void emitHr(const char* operation,HRESULT hr){
    char message[160];
    sprintf(message,"%s: 0x%08lX",operation?operation:"capture failed",(unsigned long)hr);
    emitErr(message);
  }

  void cleanup(){
    releaseStream();
    if(comInitialized){CoUninitialize();comInitialized=false;}
  }

  void releaseStream(){
    if(captureEvent){CloseHandle(captureEvent);captureEvent=nullptr;}
    if(captureClient){captureClient->Release();captureClient=nullptr;}
    if(audioClient){audioClient->Release();audioClient=nullptr;}
    if(mixFormat){CoTaskMemFree(mixFormat);mixFormat=nullptr;}
    if(device){device->Release();device=nullptr;}
    if(enumerator){enumerator->Release();enumerator=nullptr;}
    bufFrames=0;floatSamples=false;
  }
};

static Napi::Value Start(const Napi::CallbackInfo& info){
  auto* cap=static_cast<Capture*>(info.Data());
  if(!info[0].IsFunction()||!info[1].IsFunction())throw Napi::Error::New(info.Env(),"args: dataCallback, errorCallback");
  DWORD targetPid=info.Length()>2&&info[2].IsNumber()?(DWORD)info[2].As<Napi::Number>().Uint32Value():GetCurrentProcessId();
  bool includeTarget=info.Length()>3&&info[3].IsBoolean()&&info[3].As<Napi::Boolean>().Value();
  bool allowSystemMix=info.Length()>4&&info[4].IsBoolean()&&info[4].As<Napi::Boolean>().Value();
  cap->start(info[0].As<Napi::Function>(),info[1].As<Napi::Function>(),targetPid,includeTarget,allowSystemMix);
  return info.Env().Undefined();
}
static Napi::Value WindowProcessId(const Napi::CallbackInfo& info){
  if(info.Length()<1||!info[0].IsString())return Napi::Number::New(info.Env(),0);
  const std::string id=info[0].As<Napi::String>().Utf8Value();
  if(id.rfind("window:",0)!=0)return Napi::Number::New(info.Env(),0);
  const size_t end=id.find(':',7);
  const std::string raw=id.substr(7,end==std::string::npos?std::string::npos:end-7);
  char* tail=nullptr;const unsigned long long value=std::strtoull(raw.c_str(),&tail,10);
  if(!value||!tail||*tail)return Napi::Number::New(info.Env(),0);
  DWORD pid=0;GetWindowThreadProcessId(reinterpret_cast<HWND>((uintptr_t)value),&pid);
  return Napi::Number::New(info.Env(),(double)pid);
}
static Napi::Value Stop(const Napi::CallbackInfo& info){
  static_cast<Capture*>(info.Data())->stop();
  return info.Env().Undefined();
}
static Napi::Value GetFormat(const Napi::CallbackInfo& info){
  return static_cast<Capture*>(info.Data())->getFormat(info.Env());
}
static Napi::Value CaptureAbi(const Napi::CallbackInfo& info){
  return Napi::String::New(info.Env(),kCaptureAbi);
}
static Napi::Object Init(Napi::Env env,Napi::Object exports){
  auto* cap=new Capture();
  exports.Set("start",Napi::Function::New(env,Start,"start",cap));
  exports.Set("stop",Napi::Function::New(env,Stop,"stop",cap));
  exports.Set("getFormat",Napi::Function::New(env,GetFormat,"getFormat",cap));
  exports.Set("windowProcessId",Napi::Function::New(env,WindowProcessId,"windowProcessId"));
  exports.Set("captureAbi",Napi::Function::New(env,CaptureAbi,"captureAbi"));
  napi_add_env_cleanup_hook(env,[](void* d){delete static_cast<Capture*>(d);},cap);
  return exports;
}
NODE_API_MODULE(pair_capture,Init)

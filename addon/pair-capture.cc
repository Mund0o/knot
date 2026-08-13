#define NOMINMAX
#include <napi.h>
#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audioclientactivationparams.h>
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

// Windows process loopback lets us capture the system mix while excluding
// Knot's process tree. This is the same class of capture Discord uses to keep
// its own voice playback out of a stream. It needs Windows 10 build 20348+.
struct ActivationState {
  HANDLE event=nullptr;
  HRESULT result=E_FAIL;
  IAudioClient* client=nullptr;
};

class ActivationHandler final : public IActivateAudioInterfaceCompletionHandler, public IAgileObject {
  std::atomic<ULONG> refs{1};
  ActivationState* state;
public:
  explicit ActivationHandler(ActivationState* s):state(s){}
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
    if(SUCCEEDED(hr)&&SUCCEEDED(activation)&&unknown) hr=unknown->QueryInterface(__uuidof(IAudioClient),(void**)&state->client);
    if(unknown)unknown->Release();
    state->result=FAILED(hr)?hr:activation;
    SetEvent(state->event);
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
  bool processIsolated=true;
  std::thread captureThread;
  Napi::ThreadSafeFunction dataCb,errCb;

  Capture()=default;
  ~Capture(){stop();}

  void start(Napi::Function dataCbFn,Napi::Function errCbFn,DWORD targetPid,bool includeTarget){
    if(runningFlag.load())return;
    dataCb=Napi::ThreadSafeFunction::New(
      dataCbFn.Env(),dataCbFn,Napi::String::New(dataCbFn.Env(),"data"),4,1
    );
    errCb=Napi::ThreadSafeFunction::New(
      errCbFn.Env(),errCbFn,Napi::String::New(errCbFn.Env(),"err"),1,1
    );
    HRESULT hr=initWasapi(targetPid,includeTarget);
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
    if(captureThread.joinable())captureThread.join();
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
    o.Set("sampleType",mixFormat->wFormatTag==WAVE_FORMAT_IEEE_FLOAT?Napi::String::New(env,"float"):Napi::String::New(env,"pcm"));
    o.Set("isolated",Napi::Boolean::New(env,processIsolated));
    o.Set("mode",Napi::String::New(env,processIsolated?"process-loopback":"system-loopback"));
    return o;
  }

private:
  HRESULT initWasapi(DWORD targetPid,bool includeTarget){
    HRESULT hr=CoInitializeEx(nullptr,COINIT_APARTMENTTHREADED);
    if(SUCCEEDED(hr))comInitialized=true;
    else if(hr!=RPC_E_CHANGED_MODE)return hr;

    processIsolated=true;

    // A window/application share captures its owning process and descendants,
    // matching Discord's application-audio model. A full-display share captures
    // every render stream except Knot and its descendants, so voice playback can
    // never be sent back to the person watching.
    ActivationState state;
    state.event=CreateEvent(nullptr,FALSE,FALSE,nullptr);
    if(!state.event)return HRESULT_FROM_WIN32(GetLastError());
    AUDIOCLIENT_ACTIVATION_PARAMS params={};
    params.ActivationType=AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
    params.ProcessLoopbackParams.TargetProcessId=targetPid?targetPid:GetCurrentProcessId();
    params.ProcessLoopbackParams.ProcessLoopbackMode=includeTarget?PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE:PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE;
    PROPVARIANT prop={};
    prop.vt=VT_BLOB;prop.blob.cbSize=sizeof(params);prop.blob.pBlobData=(BYTE*)&params;
    auto* handler=new ActivationHandler(&state);
    // Resolve dynamically: older SDK link libraries do not always export this
    // newer API even though supported Windows releases do. That lets one addon
    // run on both current and older Windows without a loader failure.
    HMODULE audioApi=LoadLibraryW(L"mmdevapi.dll");
    auto activate=audioApi?reinterpret_cast<decltype(&ActivateAudioInterfaceAsync)>(GetProcAddress(audioApi,"ActivateAudioInterfaceAsync")):nullptr;
    IActivateAudioInterfaceAsyncOperation* operation=nullptr;
    hr=activate?activate(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,__uuidof(IAudioClient),&prop,handler,&operation):HRESULT_FROM_WIN32(ERROR_PROC_NOT_FOUND);
    if(FAILED(hr)){
      if(audioApi)FreeLibrary(audioApi);handler->Release();CloseHandle(state.event);
      // Process-loopback arrived in Windows 10 build 20348. Older supported
      // Windows 10 installations reject its virtual endpoint entirely. Fall
      // back to the default render endpoint so a share still has sound rather
      // than silently attaching an always-empty WebRTC track.
      processIsolated=false;
      return initSystemLoopback();
    }
    WaitForSingleObject(state.event,INFINITE);
    if(operation)operation->Release();
    if(audioApi)FreeLibrary(audioApi);
    handler->Release();CloseHandle(state.event);
    if(FAILED(state.result)){
      processIsolated=false;
      return initSystemLoopback();
    }
    audioClient=state.client;

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

  HRESULT initSystemLoopback(){
    HRESULT hr=CoCreateInstance(__uuidof(MMDeviceEnumerator),nullptr,CLSCTX_ALL,__uuidof(IMMDeviceEnumerator),(void**)&enumerator);
    if(FAILED(hr))return hr;
    hr=enumerator->GetDefaultAudioEndpoint(eRender,eConsole,&device);
    if(FAILED(hr))return hr;
    hr=device->Activate(__uuidof(IAudioClient),CLSCTX_ALL,nullptr,(void**)&audioClient);
    if(FAILED(hr))return hr;
    auto* requested=(WAVEFORMATEX*)CoTaskMemAlloc(sizeof(WAVEFORMATEX));
    if(!requested)return E_OUTOFMEMORY;
    ZeroMemory(requested,sizeof(WAVEFORMATEX));
    requested->wFormatTag=WAVE_FORMAT_PCM;requested->nChannels=2;requested->nSamplesPerSec=48000;requested->wBitsPerSample=16;
    requested->nBlockAlign=requested->nChannels*requested->wBitsPerSample/8;requested->nAvgBytesPerSec=requested->nSamplesPerSec*requested->nBlockAlign;
    mixFormat=requested;
    hr=audioClient->Initialize(AUDCLNT_SHAREMODE_SHARED,AUDCLNT_STREAMFLAGS_LOOPBACK|AUDCLNT_STREAMFLAGS_EVENTCALLBACK|AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,0,0,mixFormat,nullptr);
    if(FAILED(hr))return hr;
    hr=audioClient->GetBufferSize(&bufFrames);
    if(FAILED(hr))return hr;
    captureEvent=CreateEvent(nullptr,FALSE,FALSE,nullptr);
    if(!captureEvent)return HRESULT_FROM_WIN32(GetLastError());
    hr=audioClient->SetEventHandle(captureEvent);
    if(FAILED(hr))return hr;
    hr=audioClient->GetService(__uuidof(IAudioCaptureClient),(void**)&captureClient);
    if(FAILED(hr))return hr;
    return audioClient->Start();
  }

  void loop(){
    HRESULT hr=S_OK;
    while(runningFlag.load()){
      if(WaitForSingleObject(captureEvent,500)!=WAIT_OBJECT_0)continue;
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
    // Process-loopback already excludes Knot's process tree, so call playback is
    // not in this mix. Keep a full stereo pass-through for music/game audio
    // instead of collapsing to mono or running a soft canceller that can
    // smear desktop sound.
    float* buf=(float*)calloc((size_t)frames*(size_t)outCh,sizeof(float));
    if(!buf)return;
    if(silent||!data){
      // calloc already initialized the interleaved stereo output to silence.
    }else if(mixFormat->wFormatTag==WAVE_FORMAT_IEEE_FLOAT){
      float* f=(float*)data;
      for(UINT32 i=0;i<frames;i++){
        float L=f[i*ch+0];
        float R=ch>1?f[i*ch+1]:L;
        buf[i*outCh+0]=L;
        buf[i*outCh+1]=R;
      }
    }else if(mixFormat->wBitsPerSample==16){
      INT16* ps=(INT16*)data;
      for(UINT32 i=0;i<frames;i++){
        float L=ps[i*ch+0]/32768.0f;
        float R=ch>1?ps[i*ch+1]/32768.0f:L;
        buf[i*outCh+0]=L;
        buf[i*outCh+1]=R;
      }
    }else{
      INT32* pl=(INT32*)data;
      for(UINT32 i=0;i<frames;i++){
        float L=pl[i*ch+0]/2147483648.0f;
        float R=ch>1?pl[i*ch+1]/2147483648.0f:L;
        buf[i*outCh+0]=L;
        buf[i*outCh+1]=R;
      }
    }

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
    if(captureEvent){CloseHandle(captureEvent);captureEvent=nullptr;}
    if(captureClient){captureClient->Release();captureClient=nullptr;}
    if(audioClient){audioClient->Release();audioClient=nullptr;}
    if(mixFormat){CoTaskMemFree(mixFormat);mixFormat=nullptr;}
    if(device){device->Release();device=nullptr;}
    if(enumerator){enumerator->Release();enumerator=nullptr;}
    if(comInitialized){CoUninitialize();comInitialized=false;}
    bufFrames=0;
  }
};

static Napi::Value Start(const Napi::CallbackInfo& info){
  auto* cap=static_cast<Capture*>(info.Data());
  if(!info[0].IsFunction()||!info[1].IsFunction())throw Napi::Error::New(info.Env(),"args: dataCallback, errorCallback");
  DWORD targetPid=info.Length()>2&&info[2].IsNumber()?(DWORD)info[2].As<Napi::Number>().Uint32Value():GetCurrentProcessId();
  bool includeTarget=info.Length()>3&&info[3].IsBoolean()&&info[3].As<Napi::Boolean>().Value();
  cap->start(info[0].As<Napi::Function>(),info[1].As<Napi::Function>(),targetPid,includeTarget);
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

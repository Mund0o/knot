#define NOMINMAX
#include <napi.h>
#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <propvarutil.h>
#include <thread>
#include <atomic>
#include <cstring>
#include <cstdlib>
#include <string>
#include <algorithm>

// Windows process loopback captures the system mix while excluding Pair's
// process tree, so call playback is not shared with the screen. This needs
// Windows 10 build 20348+. Older Windows is not given an endpoint-loopback
// fallback: that mix can still contain Pair playback (call voice and remote
// screen audio), so the app shares video only when process exclusion fails.
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
  bool runningFlag=false;
  IAudioClient* audioClient=nullptr;
  IAudioCaptureClient* captureClient=nullptr;
  WAVEFORMATEX* mixFormat=nullptr;
  UINT32 bufFrames=0;
  HANDLE captureEvent=nullptr;
  bool comInitialized=false;
  std::thread captureThread;
  Napi::ThreadSafeFunction dataCb,errCb;

  Capture()=default;
  ~Capture(){stop();cleanup();}

  void start(Napi::Function dataCbFn,Napi::Function errCbFn){
    if(runningFlag)return;
    dataCb=Napi::ThreadSafeFunction::New(
      dataCbFn.Env(),dataCbFn,Napi::String::New(dataCbFn.Env(),"data"),0,1
    );
    errCb=Napi::ThreadSafeFunction::New(
      errCbFn.Env(),errCbFn,Napi::String::New(errCbFn.Env(),"err"),0,1
    );
    HRESULT hr=initWasapi();
    if(FAILED(hr)){
      char m[128];sprintf(m,"WASAPI init failed: 0x%08lX",(unsigned long)hr);
      throw Napi::Error::New(dataCbFn.Env(),m);
    }
    runningFlag=true;
    captureThread=std::thread(&Capture::loop,this);
  }

  void stop(){
    runningFlag=false;
    if(captureThread.joinable())captureThread.join();
    if(dataCb){dataCb.Release();dataCb=nullptr;}
    if(errCb){errCb.Release();errCb=nullptr;}
  }

  // Kept for preload ABI compatibility; process exclusion needs no voice reference.
  void pushRef(float*,size_t){}

  Napi::Object getFormat(Napi::Env env){
    auto o=Napi::Object::New(env);
    if(!mixFormat){o.Set("available",Napi::Boolean::New(env,false));return o;}
    o.Set("sampleRate",Napi::Number::New(env,(double)mixFormat->nSamplesPerSec));
    o.Set("channels",Napi::Number::New(env,(double)mixFormat->nChannels));
    o.Set("bitsPerSample",Napi::Number::New(env,(double)mixFormat->wBitsPerSample));
    o.Set("sampleType",mixFormat->wFormatTag==WAVE_FORMAT_IEEE_FLOAT?Napi::String::New(env,"float"):Napi::String::New(env,"pcm"));
    o.Set("mode",Napi::String::New(env,"process"));
    o.Set("available",Napi::Boolean::New(env,true));
    return o;
  }

private:
  HRESULT finishClientInit(){
    HRESULT hr=audioClient->GetBufferSize(&bufFrames);
    if(FAILED(hr))return hr;
    captureEvent=CreateEvent(nullptr,FALSE,FALSE,nullptr);
    if(!captureEvent)return E_FAIL;
    hr=audioClient->SetEventHandle(captureEvent);
    if(FAILED(hr))return hr;
    return audioClient->GetService(__uuidof(IAudioCaptureClient),(void**)&captureClient);
  }

  HRESULT initProcessLoopback(){
    ActivationState state;
    state.event=CreateEvent(nullptr,FALSE,FALSE,nullptr);
    if(!state.event)return HRESULT_FROM_WIN32(GetLastError());
    AUDIOCLIENT_ACTIVATION_PARAMS params={};
    params.ActivationType=AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
    params.ProcessLoopbackParams.TargetProcessId=GetCurrentProcessId();
    params.ProcessLoopbackParams.ProcessLoopbackMode=PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE;
    PROPVARIANT prop={};
    prop.vt=VT_BLOB;prop.blob.cbSize=sizeof(params);prop.blob.pBlobData=(BYTE*)&params;
    auto* handler=new ActivationHandler(&state);
    HMODULE audioApi=LoadLibraryW(L"mmdevapi.dll");
    auto activate=audioApi?reinterpret_cast<decltype(&ActivateAudioInterfaceAsync)>(GetProcAddress(audioApi,"ActivateAudioInterfaceAsync")):nullptr;
    IActivateAudioInterfaceAsyncOperation* operation=nullptr;
    HRESULT hr=activate?activate(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,__uuidof(IAudioClient),&prop,handler,&operation):HRESULT_FROM_WIN32(ERROR_PROC_NOT_FOUND);
    if(FAILED(hr)){if(audioApi)FreeLibrary(audioApi);handler->Release();CloseHandle(state.event);return hr;}
    WaitForSingleObject(state.event,INFINITE);
    if(operation)operation->Release();
    if(audioApi)FreeLibrary(audioApi);
    handler->Release();CloseHandle(state.event);
    if(FAILED(state.result))return state.result;
    audioClient=state.client;
    auto* requested=(WAVEFORMATEX*)CoTaskMemAlloc(sizeof(WAVEFORMATEX));
    if(!requested)return E_OUTOFMEMORY;
    ZeroMemory(requested,sizeof(WAVEFORMATEX));
    requested->wFormatTag=WAVE_FORMAT_PCM;requested->nChannels=2;requested->nSamplesPerSec=48000;requested->wBitsPerSample=16;
    requested->nBlockAlign=requested->nChannels*requested->wBitsPerSample/8;requested->nAvgBytesPerSec=requested->nSamplesPerSec*requested->nBlockAlign;
    mixFormat=requested;
    hr=audioClient->Initialize(AUDCLNT_SHAREMODE_SHARED,AUDCLNT_STREAMFLAGS_LOOPBACK|AUDCLNT_STREAMFLAGS_EVENTCALLBACK|AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,0,0,mixFormat,nullptr);
    if(FAILED(hr))return hr;
    return finishClientInit();
  }

  HRESULT initWasapi(){
    HRESULT hr=CoInitializeEx(nullptr,COINIT_APARTMENTTHREADED);
    if(SUCCEEDED(hr))comInitialized=true;
    else if(hr!=RPC_E_CHANGED_MODE)return hr;

    // Process exclusion only. Endpoint loopback is intentionally unavailable:
    // it cannot guarantee Pair playback stays out of the share mix.
    return initProcessLoopback();
  }

  void loop(){
    HRESULT hr=audioClient->Start();
    if(FAILED(hr)){emitErr("start failed");return;}
    while(runningFlag){
      if(WaitForSingleObject(captureEvent,500)!=WAIT_OBJECT_0)continue;
      UINT32 pktLen=0;
      hr=captureClient->GetNextPacketSize(&pktLen);
      while(pktLen>0&&runningFlag){
        BYTE* data=nullptr;UINT32 frames=0;DWORD flags=0;
        hr=captureClient->GetBuffer(&data,&frames,&flags,nullptr,nullptr);
        if(FAILED(hr)||frames==0){if(FAILED(hr))break;captureClient->ReleaseBuffer(frames);hr=captureClient->GetNextPacketSize(&pktLen);continue;}
        if(!(flags&AUDCLNT_BUFFERFLAGS_SILENT))process(data,frames);
        captureClient->ReleaseBuffer(frames);
        hr=captureClient->GetNextPacketSize(&pktLen);
      }
    }
    audioClient->Stop();
  }

  void process(BYTE* data,UINT32 frames){
    const int ch=mixFormat&&mixFormat->nChannels>0?mixFormat->nChannels:2;
    const int outCh=2;
    float* buf=(float*)calloc((size_t)frames*(size_t)outCh,sizeof(float));
    if(!buf)return;

    auto sampleAt=[&](UINT32 i,int c)->float{
      if(mixFormat->wFormatTag==WAVE_FORMAT_IEEE_FLOAT){
        float* f=(float*)data;
        return f[i*ch+std::min(c,ch-1)];
      }
      if(mixFormat->wBitsPerSample==16){
        INT16* ps=(INT16*)data;
        return ps[i*ch+std::min(c,ch-1)]/32768.0f;
      }
      INT32* pl=(INT32*)data;
      return pl[i*ch+std::min(c,ch-1)]/2147483648.0f;
    };

    // Process-loopback exclusion already omits Pair's process tree.
    for(UINT32 i=0;i<frames;i++){
      float L=sampleAt(i,0);
      float R=ch>1?sampleAt(i,1):L;
      buf[i*outCh+0]=L;
      buf[i*outCh+1]=R;
    }

    UINT32 fCopy=frames;
    auto status=dataCb.NonBlockingCall([buf,fCopy](Napi::Env e,Napi::Function cb){
      auto ab=Napi::ArrayBuffer::New(e,buf,(size_t)fCopy*2*sizeof(float),[](Napi::Env, void* data){std::free(data);});
      cb.Call({ab,Napi::Number::New(e,(double)fCopy)});
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

  void cleanup(){
    if(captureEvent)CloseHandle(captureEvent);
    if(captureClient)captureClient->Release();
    if(audioClient)audioClient->Release();
    if(mixFormat)CoTaskMemFree(mixFormat);
    if(comInitialized)CoUninitialize();
    captureEvent=nullptr;captureClient=nullptr;audioClient=nullptr;mixFormat=nullptr;comInitialized=false;
  }
};

static Napi::Value Start(const Napi::CallbackInfo& info){
  auto* cap=static_cast<Capture*>(info.Data());
  if(!info[0].IsFunction()||!info[1].IsFunction())throw Napi::Error::New(info.Env(),"args: dataCallback, errorCallback");
  cap->start(info[0].As<Napi::Function>(),info[1].As<Napi::Function>());
  return info.Env().Undefined();
}
static Napi::Value Stop(const Napi::CallbackInfo& info){
  static_cast<Capture*>(info.Data())->stop();
  return info.Env().Undefined();
}
static Napi::Value PushRef(const Napi::CallbackInfo& info){
  float* data=nullptr;
  size_t len=0;
  if(info[0].IsBuffer()){
    auto buf=info[0].As<Napi::Buffer<float>>();
    data=buf.Data();len=buf.Length();
  }else if(info[0].IsTypedArray()){
    auto arr=info[0].As<Napi::Float32Array>();
    data=arr.Data();len=arr.ElementLength();
  }
  if(data&&len>0)static_cast<Capture*>(info.Data())->pushRef(data,len);
  return info.Env().Undefined();
}
static Napi::Value GetFormat(const Napi::CallbackInfo& info){
  return static_cast<Capture*>(info.Data())->getFormat(info.Env());
}
static Napi::Object Init(Napi::Env env,Napi::Object exports){
  auto* cap=new Capture();
  exports.Set("start",Napi::Function::New(env,Start,"start",cap));
  exports.Set("stop",Napi::Function::New(env,Stop,"stop",cap));
  exports.Set("pushReference",Napi::Function::New(env,PushRef,"pushReference",cap));
  exports.Set("getFormat",Napi::Function::New(env,GetFormat,"getFormat",cap));
  napi_add_env_cleanup_hook(env,[](void* d){delete static_cast<Capture*>(d);},cap);
  return exports;
}
NODE_API_MODULE(pair_capture,Init)

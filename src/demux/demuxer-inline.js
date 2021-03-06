/*  inline demuxer.
 *   probe fragments and instantiate appropriate demuxer depending on content type (TSDemuxer, AACDemuxer, ...)
 */

import Event from '../events';
import {ErrorTypes, ErrorDetails} from '../errors';
import Decrypter from '../crypt/decrypter';
import AACDemuxer from '../demux/aacdemuxer';
import MP4Demuxer from '../demux/mp4demuxer';
import TSDemuxer from '../demux/tsdemuxer';
import MP4Remuxer from '../remux/mp4-remuxer';
import PassThroughRemuxer from '../remux/passthrough-remuxer';

class DemuxerInline {

  constructor(observer,typeSupported, config) {
    this.observer = observer;
    this.typeSupported = typeSupported;
    this.config = config;
  }

  destroy() {
    var demuxer = this.demuxer;
    if (demuxer) {
      demuxer.destroy();
    }
  }

  push(data, decryptdata, initSegment, audioCodec, videoCodec, timeOffset, discontinuity, trackSwitch, contiguous, duration,accurateTimeOffset,defaultInitPTS) {
    if ((data.byteLength > 0) && (decryptdata != null) && (decryptdata.key != null) && (decryptdata.method === 'AES-128')) {
      let decrypter = this.decrypter;
      if (decrypter == null) {
        decrypter = this.decrypter = new Decrypter(this.observer, this.config);
      }
      var localthis = this;
      // performance.now() not available on WebWorker, at least on Safari Desktop
      var startTime;
      try {
        startTime = performance.now();
      } catch(error) {
        startTime = Date.now();
      }
      decrypter.decrypt(data, decryptdata.key.buffer, decryptdata.iv.buffer, function (decryptedData) {
        var endTime;
        try {
          endTime = performance.now();
        } catch(error) {
          endTime = Date.now();
        }
        localthis.observer.trigger(Event.FRAG_DECRYPTED, { stats: { tstart: startTime, tdecrypt: endTime } });
        localthis.pushDecrypted(new Uint8Array(decryptedData), new Uint8Array(initSegment), audioCodec, videoCodec, timeOffset, discontinuity, trackSwitch, contiguous, duration, accurateTimeOffset,defaultInitPTS);
      });
    } else {
      this.pushDecrypted(new Uint8Array(data), new Uint8Array(initSegment), audioCodec, videoCodec, timeOffset, discontinuity, trackSwitch, contiguous, duration,accurateTimeOffset,defaultInitPTS);
    }
  }

  pushDecrypted(data, initSegment, audioCodec, videoCodec, timeOffset, discontinuity, trackSwitch, contiguous, duration,accurateTimeOffset,defaultInitPTS) {
    var demuxer = this.demuxer;
    if (!demuxer || 
       // in case of continuity change, we might switch from content type (AAC container to TS container for example)
       // so let's check that current demuxer is still valid
        (discontinuity && !this.probe(data))) {
      const observer = this.observer;
      const typeSupported = this.typeSupported;
      const config = this.config;
      const muxConfig = [ {demux : TSDemuxer,  remux : MP4Remuxer},
                          {demux : AACDemuxer, remux : MP4Remuxer},
                          {demux : MP4Demuxer, remux : PassThroughRemuxer}];

      // probe for content type
      for (let i in muxConfig) {
        const mux = muxConfig[i];
        const probe = mux.demux.probe;
        if(probe(data)) {
          const remuxer = this.remuxer = new mux.remux(observer,config,typeSupported);
          demuxer = new mux.demux(observer,remuxer,config,typeSupported);
          this.probe = probe;
          break;
        }
      }
      if(!demuxer) {
        observer.trigger(Event.ERROR, {type : ErrorTypes.MEDIA_ERROR, details: ErrorDetails.FRAG_PARSING_ERROR, fatal: true, reason: 'no demux matching with content found'});
        return;
      }
      this.demuxer = demuxer;
    }
    const remuxer = this.remuxer;

    if (discontinuity || trackSwitch) {
      demuxer.resetInitSegment(initSegment,audioCodec,videoCodec,duration);
      remuxer.resetInitSegment();
    }
    if (discontinuity) {
      demuxer.resetTimeStamp();
      remuxer.resetTimeStamp(defaultInitPTS);
    }
    demuxer.append(data,timeOffset,contiguous,accurateTimeOffset);
  }
}

export default DemuxerInline;

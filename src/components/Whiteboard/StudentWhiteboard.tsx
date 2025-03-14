import React, { useRef, useState, useEffect, useCallback } from 'react';
import { ReactSketchCanvas, ReactSketchCanvasRef } from 'react-sketch-canvas';
import { Video } from 'lucide-react';
import { io, Socket } from 'socket.io-client';
import { RecordRTCPromisesHandler } from 'recordrtc';
import { uploadSessionRecording } from '../../lib/cloudinary';
import { WhiteboardUpdate, TeacherStatus } from '../../types/socket';

const socket: Socket = io(import.meta.env.VITE_API_URL, {
  transports: ['websocket', 'polling'],
  reconnection: true,
  reconnectionAttempts: 5,
  reconnectionDelay: 1000,
  timeout: 60000,
});

type RecordingState = 'idle' | 'starting' | 'recording' | 'stopping' | 'saving';

const StudentWhiteboard: React.FC = () => {
  const canvasRef = useRef<ReactSketchCanvasRef | null>(null);
  const recorderRef = useRef<RecordRTCPromisesHandler | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [isTeacherLive, setIsTeacherLive] = useState(false);
  const [currentTeacherId, setCurrentTeacherId] = useState<string | null>(null);
  const [canvasSize, setCanvasSize] = useState({ width: 800, height: 600 });
  const [recordingState, setRecordingState] = useState<RecordingState>('idle');
  const lastUpdateRef = useRef<string>('[]');

  const handleWhiteboardUpdate = useCallback(async (data: WhiteboardUpdate) => {
    if (!canvasRef.current) return;

    try {
      lastUpdateRef.current = data.whiteboardData;
      await canvasRef.current.clearCanvas();
      if (data.whiteboardData && data.whiteboardData !== '[]') {
        const paths = JSON.parse(data.whiteboardData);
        await canvasRef.current.loadPaths(paths);
      }
    } catch (error) {
      console.error('Error updating whiteboard:', error);
    }
  }, []);

  const cleanupRecording = useCallback(() => {
    try {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => {
          try {
            track.stop();
          } catch (e) {
            console.error('Error stopping track:', e);
          }
        });
        streamRef.current = null;
      }
      recorderRef.current = null;
      setRecordingState('idle');
    } catch (error) {
      console.error('Error in cleanup:', error);
      setRecordingState('idle');
    }
  }, []);

  const handleRecordingComplete = useCallback(async () => {
    if (!recorderRef.current || !currentTeacherId || recordingState !== 'stopping') {
      console.log('Cannot complete recording:', {
        hasRecorder: !!recorderRef.current,
        hasTeacherId: !!currentTeacherId,
        state: recordingState
      });
      return;
    }

    try {
      setRecordingState('saving');

      const blob = await recorderRef.current.getBlob();
      if (!blob || blob.size === 0) {
        throw new Error('Empty recording blob');
      }

      const videoBlob = new Blob([blob], { type: 'video/webm' });
      const videoUrl = await uploadSessionRecording(videoBlob);
      const whiteboardData = lastUpdateRef.current;

      const response = await fetch(`${import.meta.env.VITE_API_URL}/api/sessions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('token')}`
        },
        body: JSON.stringify({
          teacherId: currentTeacherId,
          videoUrl,
          whiteboardData
        })
      });

      if (!response.ok) {
        throw new Error('Failed to save session');
      }

      alert('Session recorded and saved successfully!');
    } catch (error) {
      console.error('Error saving recording:', error);
      alert('Failed to save recording. Please try again.');
    } finally {
      cleanupRecording();
    }
  }, [currentTeacherId, cleanupRecording, recordingState]);

  const toggleRecording = async () => {
    if (!isTeacherLive) {
      alert('Cannot record when teacher is not live');
      return;
    }

    if (recordingState === 'recording') {
      // Stop recording
      setRecordingState('stopping');
      try {
        if (recorderRef.current) {
          await recorderRef.current.stopRecording();
          await handleRecordingComplete();
        }
      } catch (error) {
        console.error('Error stopping recording:', error);
        cleanupRecording();
      }
    } else if (recordingState === 'idle') {
      // Start recording
      setRecordingState('starting');
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia({
          video: {
            displaySurface: 'browser',
            width: { ideal: 1920 },
            height: { ideal: 1080 }
          }
        });

        streamRef.current = stream;
        recorderRef.current = new RecordRTCPromisesHandler(stream, {
          type: 'video',
          mimeType: 'video/webm;codecs=vp9',
          frameRate: 30,
          quality: 'high',
          disableLogs: false,
        });

        await recorderRef.current.startRecording();
        setRecordingState('recording');

        // Handle screen sharing stop
        stream.getVideoTracks()[0].onended = async () => {
          if (recordingState === 'recording') {
            setRecordingState('stopping');
            if (recorderRef.current) {
              await recorderRef.current.stopRecording();
              await handleRecordingComplete();
            }
          }
        };
      } catch (error) {
        console.error('Error starting recording:', error);
        cleanupRecording();
        if (error instanceof Error && error.name === 'NotAllowedError') {
          alert('Please allow screen recording to continue.');
        } else {
          alert('Failed to start recording. Please try again.');
        }
      }
    }
  };

  // Handle window resize
  useEffect(() => {
    const handleResize = () => {
      const container = document.getElementById('student-whiteboard-container');
      if (container) {
        const width = container.clientWidth;
        const height = Math.min(window.innerHeight - 200, width * 0.75);
        setCanvasSize({ width, height });
      }
    };

    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Socket event handlers
  useEffect(() => {
    const handleTeacherOnline = (data: TeacherStatus) => {
      setIsTeacherLive(true);
      setCurrentTeacherId(data.teacherId);
      socket.emit('joinTeacherRoom', data.teacherId);
    };

    const handleTeacherOffline = async () => {
      if (recordingState === 'recording') {
        setRecordingState('stopping');
        if (recorderRef.current) {
          await recorderRef.current.stopRecording();
          await handleRecordingComplete();
        }
      }
      setIsTeacherLive(false);
      setCurrentTeacherId(null);
      if (canvasRef.current) {
        canvasRef.current.clearCanvas();
      }
    };

    const handleConnect = () => {
      socket.emit('checkTeacherStatus');
    };

    const handleDisconnect = async () => {
      if (recordingState === 'recording') {
        setRecordingState('stopping');
        if (recorderRef.current) {
          await recorderRef.current.stopRecording();
          await handleRecordingComplete();
        }
      }
    };

    socket.on('whiteboardUpdate', handleWhiteboardUpdate);
    socket.on('teacherOnline', handleTeacherOnline);
    socket.on('teacherOffline', handleTeacherOffline);
    socket.on('connect', handleConnect);
    socket.on('disconnect', handleDisconnect);

    socket.emit('checkTeacherStatus');

    return () => {
      socket.off('whiteboardUpdate', handleWhiteboardUpdate);
      socket.off('teacherOnline', handleTeacherOnline);
      socket.off('teacherOffline', handleTeacherOffline);
      socket.off('connect', handleConnect);
      socket.off('disconnect', handleDisconnect);

      if (currentTeacherId) {
        socket.emit('leaveTeacherRoom', currentTeacherId);
      }
      cleanupRecording();
    };
  }, [handleWhiteboardUpdate, handleRecordingComplete, recordingState, cleanupRecording]);

  const getRecordingStatus = () => {
    switch (recordingState) {
      case 'starting':
        return 'Initializing recording...';
      case 'recording':
        return 'Recording in progress...';
      case 'stopping':
        return 'Stopping recording...';
      case 'saving':
        return 'Saving recording...';
      default:
        return 'Session in progress';
    }
  };

  if (!isTeacherLive) {
    return (
      <div className="p-4">
        <div className="mb-4">
          <h2 className="text-2xl font-bold">Live Whiteboard</h2>
        </div>
        <div className="border rounded-lg overflow-hidden bg-white p-8 flex items-center justify-center min-h-[300px] sm:min-h-[400px] md:min-h-[500px]">
          <div className="text-center text-gray-500">
            <p className="text-xl font-semibold mb-2">Waiting for teacher...</p>
            <p>The session will begin when the teacher starts the whiteboard</p>
          </div>
        </div>
      </div>
    );
  }

  const isRecordingInProgress = recordingState !== 'idle';
  const isButtonDisabled = recordingState === 'stopping' || recordingState === 'saving' || recordingState === 'starting';

  return (
    <div className="p-4">
      <div className="mb-4 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-2xl font-bold">Live Whiteboard Session</h2>
          <p className="text-sm text-gray-600 mt-1">
            {getRecordingStatus()}
          </p>
        </div>
        <button
          onClick={toggleRecording}
          disabled={isButtonDisabled}
          className={`flex items-center gap-2 px-4 py-2 rounded-md transition-colors ${
            isRecordingInProgress
              ? 'bg-red-500 hover:bg-red-600'
              : 'bg-green-500 hover:bg-green-600'
          } text-white ${isButtonDisabled ? 'opacity-50 cursor-not-allowed' : ''}`}
        >
          <Video size={20} />
          {isRecordingInProgress ? 'Stop Recording' : 'Start Recording'}
        </button>
      </div>
      <div id="student-whiteboard-container" className="border rounded-lg overflow-hidden bg-white">
        <ReactSketchCanvas
          ref={canvasRef}
          strokeWidth={4}
          strokeColor="black"
          width={`${canvasSize.width}px`}
          height={`${canvasSize.height}px`}
          style={{ pointerEvents: 'none' }}
          canvasColor="white"
          exportWithBackgroundImage={false}
          withTimestamp={false}
          allowOnlyPointerType="all"
          className="touch-none"
        />
      </div>
    </div>
  );
};

export default StudentWhiteboard;
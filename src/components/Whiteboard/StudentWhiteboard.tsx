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

const StudentWhiteboard: React.FC = () => {
  const canvasRef = useRef<ReactSketchCanvasRef | null>(null);
  const recorderRef = useRef<RecordRTCPromisesHandler | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [isTeacherLive, setIsTeacherLive] = useState(false);
  const [currentTeacherId, setCurrentTeacherId] = useState<string | null>(null);
  const [canvasSize, setCanvasSize] = useState({ width: 800, height: 600 });
  const [isRecording, setIsRecording] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
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
    console.log('Cleaning up recording...', {
      hasStream: !!streamRef.current,
      hasRecorder: !!recorderRef.current,
      isRecording,
      isSaving,
      isStarting
    });

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
      setIsRecording(false);
      setIsSaving(false);
      setIsStarting(false);

      console.log('Cleanup complete. New state:', {
        hasStream: !!streamRef.current,
        hasRecorder: !!recorderRef.current,
        isRecording: false,
        isSaving: false,
        isStarting: false
      });
    } catch (error) {
      console.error('Error in cleanup:', error);
    }
  }, [isRecording, isSaving, isStarting]);

  const handleRecordingComplete = useCallback(async () => {
    console.log('Handling recording completion...', {
      hasRecorder: !!recorderRef.current,
      hasTeacherId: !!currentTeacherId,
      isRecording,
      isSaving
    });

    if (!recorderRef.current || !currentTeacherId || !isRecording) {
      console.log('Cannot complete recording - missing requirements');
      return;
    }

    try {
      setIsSaving(true);
      console.log('Getting blob from recorder...');

      const blob = await recorderRef.current.getBlob();
      if (!blob || blob.size === 0) {
        throw new Error('Empty recording blob');
      }

      console.log('Creating video blob...', { blobSize: blob.size });
      const videoBlob = new Blob([blob], { type: 'video/webm' });
      console.log('Uploading to Cloudinary...');
      const videoUrl = await uploadSessionRecording(videoBlob);
      const whiteboardData = lastUpdateRef.current;

      console.log('Saving session to backend...');
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

      console.log('Session saved successfully');
      alert('Session recorded and saved successfully!');
    } catch (error) {
      console.error('Error saving recording:', error);
      alert('Failed to save recording. Please try again.');
    } finally {
      cleanupRecording();
    }
  }, [currentTeacherId, cleanupRecording, isRecording, isSaving]);

  const toggleRecording = async () => {
    console.log('Toggle recording called. Current state:', {
      isTeacherLive,
      isRecording,
      isSaving,
      isStarting,
      hasRecorder: !!recorderRef.current,
      hasStream: !!streamRef.current
    });

    if (!isTeacherLive) {
      alert('Cannot record when teacher is not live');
      return;
    }

    if (isRecording) {
      console.log('Attempting to stop recording...');
      try {
        if (recorderRef.current) {
          console.log('Stopping RecordRTC...');
          await recorderRef.current.stopRecording();
          console.log('RecordRTC stopped, handling completion...');
          await handleRecordingComplete();
        } else {
          console.log('No recorder found to stop');
          cleanupRecording();
        }
      } catch (error) {
        console.error('Error stopping recording:', error);
        cleanupRecording();
      }
    } else {
      console.log('Attempting to start recording...');
      setIsStarting(true);
      try {
        console.log('Requesting screen sharing...');
        const stream = await navigator.mediaDevices.getDisplayMedia({
          video: {
            displaySurface: 'browser',
            width: { ideal: 1920 },
            height: { ideal: 1080 }
          }
        });

        console.log('Screen share granted, setting up recorder...');
        streamRef.current = stream;
        recorderRef.current = new RecordRTCPromisesHandler(stream, {
          type: 'video',
          mimeType: 'video/webm;codecs=vp9',
          frameRate: 30,
          quality: 'high',
          disableLogs: false,
        });

        console.log('Starting RecordRTC...');
        await recorderRef.current.startRecording();
        console.log('RecordRTC started successfully');
        setIsRecording(true);
        setIsStarting(false);

        stream.getVideoTracks()[0].onended = async () => {
          console.log('Screen share ended by user');
          if (isRecording && !isSaving) {
            console.log('Auto-stopping recording due to screen share end');
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

  useEffect(() => {
    const handleTeacherOnline = (data: TeacherStatus) => {
      setIsTeacherLive(true);
      setCurrentTeacherId(data.teacherId);
      socket.emit('joinTeacherRoom', data.teacherId);
    };

    const handleTeacherOffline = async () => {
      if (isRecording && !isSaving) {
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
      if (isRecording && !isSaving) {
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
  }, [
    handleWhiteboardUpdate,
    handleRecordingComplete,
    isRecording,
    isSaving,
    currentTeacherId,
    cleanupRecording
  ]);

  // Debug effect to log state changes
  useEffect(() => {
    console.log('Recording state changed:', {
      isRecording,
      isSaving,
      isStarting,
      hasRecorder: !!recorderRef.current,
      hasStream: !!streamRef.current
    });
  }, [isRecording, isSaving, isStarting]);

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

  const isButtonDisabled = isSaving || isStarting;

  return (
    <div className="p-4">
      <div className="mb-4 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-2xl font-bold">Live Whiteboard Session</h2>
          <p className="text-sm text-gray-600 mt-1">
            {isSaving ? 'Saving recording...' :
             isStarting ? 'Starting recording...' :
             isRecording ? 'Recording in progress...' :
             'Session in progress'}
          </p>
        </div>
        <button
          onClick={toggleRecording}
          disabled={isButtonDisabled}
          className={`flex items-center gap-2 px-4 py-2 rounded-md transition-colors ${
            isRecording
              ? 'bg-red-500 hover:bg-red-600'
              : 'bg-green-500 hover:bg-green-600'
          } text-white ${isButtonDisabled ? 'opacity-50 cursor-not-allowed' : ''}`}
        >
          <Video size={20} />
          {isRecording ? 'Stop Recording' : 'Start Recording'}
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
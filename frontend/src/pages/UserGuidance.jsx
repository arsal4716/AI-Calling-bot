import React from 'react';
import { Phone, Link, Code, Settings, Shield, Zap, RefreshCw, Cloud } from 'lucide-react';
import { motion } from 'framer-motion';

const UserGuidance = () => {
  const sections = [
    {
      icon: <Phone className="h-8 w-8" />,
      title: 'Dialer Integration Overview',
      content: 'Our platform is designed to work with ANY dialer system. Your existing dialer (Vapi, Vicidial, etc.) only needs to place calls through Twilio - we handle all AI interactions.',
      color: 'bg-blue-500',
    },
    {
      icon: <Link className="h-8 w-8" />,
      title: 'What You Need to Configure',
      content: 'Based on your dialer type, you need to provide specific Twilio configuration.',
      color: 'bg-green-500',
      subsections: [
        {
          title: 'For API-Based Dialers (Vapi, etc.)',
          items: [
            'Use the Twilio phone number assigned to your campaign',
            'Configure webhook URL to: POST /api/twilio/webhook',
            'Set Caller ID to your Twilio DID',
          ],
        },
        {
          title: 'For SIP-Based Dialers (Vicidial, Asterisk, etc.)',
          items: [
            'Use Twilio SIP trunk credentials provided',
            'Point your SIP dialer to our Twilio SIP domain',
            'Same webhook configuration as above',
          ],
        },
      ],
    },
    {
      icon: <RefreshCw className="h-8 w-8" />,
      title: 'What NEVER Changes',
      content: 'Our architecture ensures these components remain constant regardless of dialer changes.',
      color: 'bg-red-500',
      items: [
        'Your dialer configuration (except Twilio details)',
        'Our AI backend code and logic',
        'Integration workflow and call flow',
        'Campaign management interface',
      ],
    },
    {
      icon: <Cloud className="h-8 w-8" />,
      title: 'AI Orchestration Flow',
      content: 'Every call follows this exact flow, managed entirely by our platform.',
      color: 'bg-purple-500',
      diagram: 'Dialer → Twilio → AI Orchestrator → Deepgram → OpenAI → ElevenLabs → Twilio → Caller',
    },
  ];

  const steps = [
    {
      number: 1,
      title: 'Create Campaign',
      description: 'Set up campaign with prompts, voice, and Twilio DID',
    },
    {
      number: 2,
      title: 'Configure Dialer',
      description: 'Update your dialer with campaign Twilio DID and webhook',
    },
    {
      number: 3,
      title: 'Upload Prompts',
      description: 'Add campaign-specific prompts via CSV or direct input',
    },
    {
      number: 4,
      title: 'Clone Voices',
      description: 'Upload voice samples to create custom AI voices',
    },
    {
      number: 5,
      title: 'Start Calling',
      description: 'AI handles all conversations - no manual intervention needed',
    },
  ];

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold text-gray-900">User Guidance & Integration</h1>
        <p className="text-gray-600 mt-2">Complete guide for dialer teams to integrate with our AI Calling Platform</p>
      </div>

      {/* Quick Start Steps */}
      <div className="bg-gradient-to-r from-blue-50 to-purple-50 rounded-2xl p-8">
        <h2 className="text-2xl font-bold text-gray-900 mb-6">Quick Start Guide</h2>
        <div className="grid grid-cols-1 md:grid-cols-5 gap-6">
          {steps.map((step) => (
            <motion.div
              key={step.number}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: step.number * 0.1 }}
              className="bg-white rounded-xl p-6 shadow-sm border border-gray-200 text-center"
            >
              <div className="h-12 w-12 bg-blue-600 text-white rounded-full flex items-center justify-center text-xl font-bold mx-auto mb-4">
                {step.number}
              </div>
              <h3 className="font-semibold text-gray-900 mb-2">{step.title}</h3>
              <p className="text-sm text-gray-600">{step.description}</p>
            </motion.div>
          ))}
        </div>
      </div>

      {/* Main Sections */}
      <div className="space-y-6">
        {sections.map((section, index) => (
          <motion.div
            key={section.title}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: index * 0.1 }}
            className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden"
          >
            <div className="p-6">
              <div className="flex items-start space-x-4 mb-4">
                <div className={`${section.color} p-3 rounded-lg text-white`}>
                  {section.icon}
                </div>
                <div className="flex-1">
                  <h2 className="text-xl font-semibold text-gray-900">{section.title}</h2>
                  <p className="text-gray-600 mt-1">{section.content}</p>
                </div>
              </div>

              {section.subsections && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-6">
                  {section.subsections.map((subsection) => (
                    <div key={subsection.title} className="bg-gray-50 rounded-lg p-4">
                      <h3 className="font-semibold text-gray-900 mb-3">{subsection.title}</h3>
                      <ul className="space-y-2">
                        {subsection.items.map((item, i) => (
                          <li key={i} className="flex items-start">
                            <Zap className="h-4 w-4 text-green-500 mr-2 mt-0.5 flex-shrink-0" />
                            <span className="text-gray-700">{item}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              )}

              {section.items && (
                <div className="mt-6">
                  <ul className="space-y-3">
                    {section.items.map((item, i) => (
                      <li key={i} className="flex items-start">
                        <Shield className="h-5 w-5 text-red-500 mr-3 mt-0.5 flex-shrink-0" />
                        <span className="text-gray-700">{item}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {section.diagram && (
                <div className="mt-6 p-4 bg-gray-900 rounded-lg">
                  <code className="text-sm text-green-400 font-mono block text-center">
                    {section.diagram}
                  </code>
                </div>
              )}
            </div>
          </motion.div>
        ))}
      </div>

      {/* Technical Details */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
        <h2 className="text-xl font-semibold text-gray-900 mb-4">Technical Implementation</h2>
        
        <div className="space-y-4">
          <div>
            <h3 className="font-medium text-gray-900 mb-2">Webhook Configuration</h3>
            <div className="bg-gray-50 p-4 rounded-lg">
              <code className="text-sm text-gray-800 font-mono">
                POST {process.env.REACT_APP_API_URL || 'https://your-domain.com'}/api/twilio/webhook
              </code>
            </div>
          </div>

          <div>
            <h3 className="font-medium text-gray-900 mb-2">Twilio Requirements</h3>
            <ul className="list-disc pl-5 space-y-2 text-gray-700">
              <li>Twilio Account with Voice capabilities</li>
              <li>Phone number or SIP trunk configured</li>
              <li>Webhook URL set in Twilio console</li>
              <li>Proper CORS configuration for your domain</li>
            </ul>
          </div>

          <div>
            <h3 className="font-medium text-gray-900 mb-2">Troubleshooting</h3>
            <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
              <p className="text-yellow-800">
                <strong>Common Issue:</strong> Calls not reaching AI
              </p>
              <ul className="mt-2 space-y-1 text-sm text-yellow-700">
                <li>• Verify Twilio webhook is correctly configured</li>
                <li>• Check campaign Twilio DID matches dialer configuration</li>
                <li>• Ensure campaign is active and has valid prompts</li>
                <li>• Verify AI service API keys are configured</li>
              </ul>
            </div>
          </div>
        </div>

        <div className="mt-8 p-4 bg-blue-50 rounded-lg border border-blue-200">
          <div className="flex items-start">
            <Settings className="h-5 w-5 text-blue-600 mr-3 mt-0.5 flex-shrink-0" />
            <div>
              <p className="text-blue-800 font-medium">Need Help?</p>
              <p className="text-blue-700 mt-1">
                Contact our integration team for dedicated support setting up your dialer.
                We provide step-by-step guidance for any dialer system.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default UserGuidance;